import * as vscode from "vscode";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import { OllamaProvider } from "../ai/ollamaProvider";
import { OllamaEmbeddingProvider } from "../ai/ollamaEmbedding";
import {
  describeStartFailure,
  resolveExecutable,
  startOllama,
} from "../ai/ollamaLauncher";
import { AIRegistry, runSetupWizard } from "../ai/registry";
import { openGeneratedMarkdown } from "../views/openDocument";
import { isGitAvailable } from "../core/git";
import { ghState } from "../core/gitSetup";
import {
  buildSetupPlan,
  GH_LOGIN_COMMAND,
  GH_LOGIN_HINT,
  setupCompleteMessage,
  RECOMMENDED_CHAT_MODEL,
  RECOMMENDED_EMBEDDING_MODEL,
  REQUIREMENTS,
  totalSizeLabel,
  manualInstallCommand,
  manualInstallNote,
  type Requirement,
  type RequirementId,
  type RequirementState,
  type SetupPlan,
  type SetupPlanEntry,
} from "../core/requirements";
import {
  detectPackageManager,
  installPackage,
  installWithBrew,
  type PackageManager,
  pullOllamaModel,
  shortenProgress,
  type InstallOutcome,
} from "../core/packageInstall";
import { withCancellableProgress, withProgress } from "../views/progress";
// ログの書き先：作品が定まらない
// AIの環境を整える案内で、**この時点ではまだ作品を選んでいない**
// （Ollama や LM Studio を入れる操作そのもの）。書き先にできる
// `.aiwriter` が無いので、記録は出力チャンネルだけに出す。
import { logFailure, logStep } from "../core/logger";
import { cancelItem } from "../views/dialogs";
import { notifyDone } from "../views/notify";

/**
 * 「これを入れれば使えるようになる」を1か所にまとめた案内（設計書6.16）。
 *
 * ## なぜ1か所にするか
 *
 * 拡張機能を入れただけでは、AIを使う機能は動かない。足りないものは
 * Ollama本体・会話モデル・埋め込みモデル・Git・GitHub CLIと複数あり、
 * どれが欠けても作者からは「AIが動かない」としか見えない。
 * **何が足りていて、何のために要るのかを一覧で見せる。**
 *
 * ## 方針を変えた（2026-08-15）
 *
 * 以前は「勝手にインストールしない。配布ページを開くだけ」としていたが、
 * 作者から**自動導入**の指定があったので改めた。ただし黙って入れることは
 * しない。**何を・どれだけ・なぜ入れるのかを見せてから、押されたら実行する。**
 * 入れたあとは拡張機能側で確かめ直し、次に足りないものへ進む。
 */

const DOWNLOAD_PAGE = "https://ollama.com/download";

export async function runFullSetup(registry: AIRegistry): Promise<void> {
  const plan = await inspect();

  if (plan.complete) {
    await showComplete(registry, plan);
    return;
  }

  const manager = await detectPackageManager();
  await showPlan(registry, plan, manager);
}

/** いま何が入っているかを調べる */
export async function inspect(): Promise<SetupPlan> {
  const states: RequirementState[] = [];

  const executable = await resolveExecutable(
    vscode.workspace
      .getConfiguration("novelai")
      .get<string>("ollama.executablePath", "") || undefined
  );
  const provider = new OllamaProvider();
  const connection = await provider.testConnection();
  // 実行ファイルがあれば「入っている」。起動していないだけの状態と分ける
  const ollamaPresent = Boolean(executable) || connection.ok;
  states.push({
    id: "ollama",
    present: ollamaPresent,
    note:
      ollamaPresent && !connection.ok
        ? "入っていますが、起動していないようです。"
        : undefined,
  });

  // モデルの有無は、起動していないと分からない
  let chatModels: string[] = [];
  if (connection.ok) {
    try {
      chatModels = (await provider.listModels()).map((model) => model.id);
    } catch {
      chatModels = [];
    }
  }
  // 埋め込み専用モデルは会話には使えないので、会話モデルの数から除く
  const conversational = chatModels.filter((name) => !isEmbeddingModel(name));
  states.push({
    id: "chatModel",
    present: conversational.length > 0,
    note:
      conversational.length > 0
        ? `いま使えるモデル: ${conversational.slice(0, 3).join("、")}`
        : undefined,
  });

  const embeddingModel = new OllamaEmbeddingProvider().model;
  states.push({
    id: "embeddingModel",
    present: connection.ok
      ? chatModels.some((name) => matchesModel(name, embeddingModel))
      : false,
  });

  states.push({ id: "git", present: await isGitAvailable() });
  const gh = await ghState();
  states.push({ id: "gh", present: gh === "ready", needsLogin: gh === "needsLogin" });

  return buildSetupPlan(states);
}

/** `bge-m3` と `bge-m3:latest` を同じものとして扱う */
function matchesModel(name: string, wanted: string): boolean {
  const strip = (value: string): string => value.replace(/:latest$/, "");
  return strip(name) === strip(wanted);
}

/** 埋め込み専用のモデルは会話に使えない。名前で見分ける */
function isEmbeddingModel(name: string): boolean {
  return /embed|bge-|e5-|gte-|ruri/i.test(name);
}

async function showComplete(
  registry: AIRegistry,
  plan: SetupPlan
): Promise<void> {
  const configure = "使うAIを選ぶ";
  const detail = "一覧を見る";
  // 任意が残っていれば、その道も出す（「すべて揃った」と読み違えないように文も分ける）
  const rest = plan.missingOptional.length + plan.needsLogin.length;
  const optional = "任意のものを見る";
  const picked = await vscode.window.showInformationMessage(
    setupCompleteMessage(plan),
    configure,
    ...(rest > 0 ? [optional] : []),
    detail
  );
  if (picked === configure) await runSetupWizard(registry);
  if (picked === optional) await showPlan(registry, plan, await detectPackageManager());
  if (picked === detail) await showDetail(plan);
}

/**
 * 足りないものを見せて、入れるかどうかを選んでもらう。
 *
 * **必須と任意を分けて示す。** 全部を必須にするとクラウドAIだけ使う作者にも
 * 十数GBの取得を強いることになる。
 */
async function showPlan(
  registry: AIRegistry,
  plan: SetupPlan,
  manager: PackageManager
): Promise<void> {
  const items: Array<vscode.QuickPickItem & { action: () => Promise<void> }> = [];

  const required = plan.missingRequired;
  const optional = plan.missingOptional;

  if (required.length > 0) {
    items.push({
      label: `$(cloud-download) 必要なものを入れる（${required.length}件）`,
      detail: `${required
        .map((entry) => entry.requirement.label)
        .join("・")}／合計 ${totalSizeLabel(required)}`,
      action: () => installEntries(registry, required, manager),
    });
  }

  for (const entry of optional) {
    items.push({
      label: `$(add) ${entry.requirement.label} を入れる`,
      detail: `任意／${entry.requirement.size ?? ""}　${entry.requirement.purpose.replace(
        /\*\*/g,
        ""
      )}`,
      action: () => installEntries(registry, [entry], manager),
    });
  }

  // 入っているがログインがまだ（gh）。入れ直しても直らないので、ログインの道を出す
  for (const entry of plan.needsLogin) {
    items.push({
      label: `$(account) ${entry.requirement.label} にログインする`,
      detail: `任意／入っていますが、GitHub へのログインがまだです。${GH_LOGIN_HINT}`,
      action: () => guideLogin(registry),
    });
  }

  if (required.length + optional.length > 1) {
    const all = [...required, ...optional];
    items.push({
      label: "$(checklist) 足りないものをすべて入れる",
      detail: `${all.length}件／合計 ${totalSizeLabel(all)}`,
      action: () => installEntries(registry, all, manager),
    });
  }

  items.push({
    label: "$(list-unordered) 何が要るのかを読む",
    detail: "それぞれ何のために使うのか、入れないと何ができないのかを表示します",
    action: () => showDetail(plan),
  });

  if (manager === "none") {
    items.push({
      label: "$(link-external) Ollamaの配布ページを開く",
      detail: "この環境では自動で入れられないため、手動で入れてください",
      action: async () => {
        await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_PAGE));
      },
    });
  }

  const summary =
    required.length > 0
      ? `AIを使うには あと${required.length}件 必要です`
      : "必須のものは揃っています（任意のものがまだです）";

  const picked = await showQuickPickKeepingFocus([...items, cancelItem()], {
    title: "統合小説執筆環境のセットアップ",
    placeHolder: summary,
    ignoreFocusOut: true,
  });
  if (picked && "action" in picked) await picked.action();
}

/** 何が要るのかを、用途つきで読める形で出す */
async function showDetail(plan: SetupPlan): Promise<void> {
  // 一度読んで閉じる案内なので、プレビュー表示（タブを増やさない）のまま
  await openGeneratedMarkdown("セットアップで入れるもの", buildSetupDocument(plan), {
    preview: true,
  });
}

export function buildSetupDocument(plan: SetupPlan): string {
  const lines = [
    "# セットアップで入れるもの",
    "",
    "この拡張機能を入れただけでは、AIを使う機能は動きません。",
    "下のものを足すと使えるようになります。**すべてを入れる必要はありません。**",
    "",
    "| | 何 | 何のために | 大きさ |",
    "|---|---|---|---|",
  ];

  for (const entry of plan.entries) {
    const mark = entry.present ? "済" : entry.needsLogin ? "ログイン待ち" : entry.requirement.level;
    lines.push(
      `| ${mark} | ${entry.requirement.label} | ${entry.requirement.purpose.replace(
        /\n/g,
        " "
      )} | ${entry.requirement.size ?? "—"} |`
    );
  }

  lines.push("", "---", "");

  for (const entry of plan.entries) {
    lines.push(`## ${entry.requirement.label}`, "");
    lines.push(
      entry.present
        ? "**入っています。**"
        : entry.needsLogin
          ? `**入っていますが、ログインがまだです**（${entry.requirement.level}）。`
          : `**まだ入っていません**（${entry.requirement.level}）。`,
      ""
    );
    lines.push(entry.requirement.purpose, "");
    if (entry.needsLogin) {
      lines.push(GH_LOGIN_HINT, "");
    } else if (!entry.present) {
      lines.push(`入れない場合：${entry.requirement.withoutIt}`, "");
    }
    if (entry.note) lines.push(entry.note, "");
  }

  lines.push(
    "---",
    "",
    "## 入れたあとに消したくなったら",
    "",
    "- Ollamaのモデル：`ollama rm <モデル名>` で消せます",
    "- Ollama本体・Git・GitHub CLI：Windowsの「アプリと機能」から削除できます",
    "- Macでは、アプリ（Ollama など）は「アプリケーション」フォルダーからゴミ箱へ入れると消せます。" +
      "Homebrew で入れたものは、ターミナルで `brew uninstall <名前>`（例：`brew uninstall ollama`）で消せます",
    "",
    "モデルを消しても、作品のファイルや設定資料は変わりません。"
  );

  return lines.join("\n");
}

/**
 * 実際に入れる。
 *
 * **1件ごとに確認は取らない。** 押す前に何を入れるか見せているので、
 * 途中で何度も聞くと作業が進まない。ただし**中止はいつでもできる**。
 */
const SHOW_LOG = "ログを見る";
/** 手で入れ終えたあとに押すボタン（作者の判断 2026-11-01） */
export const RECHECK_AFTER_MANUAL = "入れ終えたので確かめる";
/**
 * 手で入れてもらう案内のあとの失敗の理由。**ボタンを出すかの目印にも使う**
 * （導入の結果の型は `core/packageInstall.ts` の共有物なので、印を足さずに文で見分ける）
 */
export const MANUAL_INSTALL_DETAIL =`入れ終わったら、この知らせの［${RECHECK_AFTER_MANUAL}］を押してください。`;

/** 導入に失敗したときの知らせのボタン。手で入れるものがあれば、確かめ直す道を先に出す */
export function installFailureButtons(details: readonly string[]): string[] {
  return details.includes(MANUAL_INSTALL_DETAIL)
    ? [RECHECK_AFTER_MANUAL, SHOW_LOG]
    : [SHOW_LOG];
}

async function installEntries(
  registry: AIRegistry,
  entries: readonly SetupPlanEntry[],
  manager: PackageManager
): Promise<void> {
  const names = entries.map((entry) => entry.requirement.label).join("\n・");
  const proceed = "入れる";
  const confirmed = await vscode.window.showWarningMessage(
    `次のものを入れます。合計 ${totalSizeLabel(entries)} ほど取得します。\n\n・${names}`,
    { modal: true, detail: "回線の速さによっては数十分かかります。途中で中止できます。" },
    proceed
  );
  if (confirmed !== proceed) return;

  const failures: string[] = [];
  const failureDetails: string[] = [];

  for (const entry of entries) {
    const outcome = await installOne(entry.requirement.id, manager);
    if (outcome.kind === "failed") {
      failures.push(`${entry.requirement.label}: ${outcome.detail}`);
      failureDetails.push(outcome.detail);
      logFailure("セットアップの導入に失敗", {
        対象: entry.requirement.label,
        理由: outcome.detail,
      });
    }
    if (outcome.kind === "cancelled") {
      notifyDone(
        `${entry.requirement.label} の導入を取りやめました。`
      );
      break;
    }
  }

  if (failures.length > 0) {
    /*
      **手で入れてもらうものがあれば、入れ終えたあとに押す道を付ける**（作者の判断
      2026-11-01）。以前は「もう一度『セットアップ（必要なものを入れる）』を実行して
      ください」と言うだけで、その名前の操作は詳細メニューに無かった（設定管理へ
      移した。設計書6.56.3）。

      この知らせは**待つ**。押されたら下の確かめ直しへ進む——コマンドを呼び直さないのは、
      いま走っているセットアップの続きがそのまま確かめ直しになっているため
      （呼び直すと同じ案内が2つ重なる）
    */
    const picked = await vscode.window.showErrorMessage(
      `一部を入れられませんでした。\n${failures.join("\n")}`,
      ...installFailureButtons(failureDetails)
    );
    if (picked === SHOW_LOG) {
      await vscode.commands.executeCommand("novelai.showLog");
    }
  }

  // 入れたあとに確かめ直して、次に足りないものへ進む
  const after = await inspect();
  if (after.complete || after.missingRequired.length === 0) {
    await showComplete(registry, after);
    return;
  }
  await showPlan(registry, after, manager);
}

/**
 * gh のログインの案内。**ログインは作者がターミナルで行う**（拡張機能は認証に触れない）。
 * 打つ1行をクリップボードへ入れられるようにする
 */
async function guideLogin(registry: AIRegistry): Promise<void> {
  const copy = "コマンドをコピー";
  const answer = await vscode.window.showInformationMessage(
    "GitHub CLI は入っていますが、GitHub へのログインがまだです。",
    {
      modal: true,
      detail: `ターミナルで次の1行を実行し、表示に沿ってログインしてください。

  ${GH_LOGIN_COMMAND}`,
    },
    copy
  );
  if (answer !== copy) return;
  await vscode.env.clipboard.writeText(GH_LOGIN_COMMAND);
  // 済んだあとに押す道を、この知らせに付ける（メニューに無い名前を言わない）
  const recheck = "ログインできたので確かめる";
  const next = await vscode.window.showInformationMessage(
    "コマンドをクリップボードへ入れました。ターミナルへ貼り付けて実行してください。",
    recheck
  );
  if (next !== recheck) return;
  const after = await inspect();
  if (after.complete || after.missingRequired.length === 0) {
    await showComplete(registry, after);
    return;
  }
  await showPlan(registry, after, await detectPackageManager());
}

/**
 * 自分で入れてもらう案内。
 *
 * **「自動で入れられません」で終わらせない。** 何を打てばよいかと、
 * 配布ページの両方を出す。コマンドはクリップボードへ入れられるようにする
 * （打ち間違いで詰まるのがいちばん多い）。
 */
async function guideManualInstall(
  requirement: Requirement,
  manager: PackageManager
): Promise<InstallOutcome> {
  const steps = requirement.manualSteps;
  if (!steps) {
    return {
      kind: "failed",
      detail: "この環境では自動で入れられません。配布ページから入れてください。",
    };
  }

  const why =
    manager === "manual" && process.platform === "darwin"
      ? "Homebrew が見つかりませんでした。"
      : "この環境では自動で入れられません。";

  // Mac で Homebrew が無いときは Mac の1行（Git なら xcode-select）を出す
  const command = manualInstallCommand(steps, process.platform);
  const actions = command
    ? ["コマンドをコピー", "配布ページを開く"]
    : ["配布ページを開く"];
  const answer = await vscode.window.showWarningMessage(
    `${requirement.label} は、ご自身で入れていただく必要があります。`,
    {
      modal: true,
      detail: [
        why,
        "",
        command
          ? `ターミナルで次の1行を実行してください。\n\n  ${command}\n`
          : "",
        // Mac にも install.sh の1行を出すので、添え書きも Mac 向けに替える
        manualInstallNote(steps, process.platform),
      ]
        .filter(Boolean)
        .join("\n"),
    },
    ...actions
  );

  if (answer === "コマンドをコピー" && command) {
    await vscode.env.clipboard.writeText(command);
    notifyDone(
      "コマンドをクリップボードへ入れました。ターミナルへ貼り付けて実行してください。"
    );
  } else if (answer === "配布ページを開く") {
    await vscode.env.openExternal(vscode.Uri.parse(steps.page));
  }

  // 入れ終わったかは分からない。**入ったことにしない**
  return { kind: "failed", detail: MANUAL_INSTALL_DETAIL };
}

async function installOne(
  id: RequirementId,
  manager: PackageManager
): Promise<InstallOutcome> {
  const requirement = REQUIREMENTS.find((item) => item.id === id);
  if (!requirement) return { kind: "failed", detail: "不明な項目です。" };

  // モデルはOllamaが起動していないと取得できない。先に起こす
  if (id === "chatModel" || id === "embeddingModel") {
    const ready = await ensureOllamaRunning();
    if (!ready) {
      return {
        kind: "failed",
        detail: "Ollamaを起動できませんでした。",
      };
    }
    const model =
      id === "chatModel"
        ? RECOMMENDED_CHAT_MODEL
        : new OllamaEmbeddingProvider().model || RECOMMENDED_EMBEDDING_MODEL;
    logStep(`セットアップ: ${model} を取得`);
    return withCancellableProgress(
      `${requirement.label} を取得しています`,
      async (progress, token) => {
        const outcome = await pullOllamaModel(model, {
          onLine: (line) => {
            if (token.isCancellationRequested) return;
            progress.report({ message: shortenProgress(line) });
          },
        });
        return token.isCancellationRequested
          ? ({ kind: "cancelled" } as InstallOutcome)
          : outcome;
      }
    );
  }

  // **自分で入れてもらう場合は、何を打つかをそのまま見せる。**
  // Linuxの公式の案内は「取ってきたスクリプトを実行する」形で、
  // 拡張機能が黙って走らせてよいものではない
  if (manager === "manual" || manager === "none") {
    return guideManualInstall(requirement, manager);
  }

  if (manager === "brew") {
    if (!requirement.brewFormula) {
      return guideManualInstall(requirement, "manual");
    }
    logStep(`セットアップ: brew install ${requirement.brewFormula}`);
    return withCancellableProgress(
      `${requirement.label} を入れています`,
      async (progress, token) => {
        const outcome = await installWithBrew(requirement.brewFormula!, {
          onLine: (line) => {
            if (token.isCancellationRequested) return;
            progress.report({ message: shortenProgress(line) });
          },
        });
        return token.isCancellationRequested
          ? ({ kind: "cancelled" } as InstallOutcome)
          : outcome;
      }
    );
  }

  if (!requirement.wingetId) {
    return { kind: "failed", detail: "自動で入れる方法がありません。" };
  }

  logStep(`セットアップ: ${requirement.wingetId} を導入`);
  return withCancellableProgress(
    `${requirement.label} を入れています`,
    async (progress, token) => {
      const outcome = await installPackage(requirement.wingetId!, {
        onLine: (line) => {
          if (token.isCancellationRequested) return;
          progress.report({ message: shortenProgress(line) });
        },
      });
      return token.isCancellationRequested
        ? ({ kind: "cancelled" } as InstallOutcome)
        : outcome;
    }
  );
}

/**
 * Ollamaを使える状態にする。
 *
 * 入れた直後は起動していないことがある。**モデルの取得の前に必ず起こす。**
 * ここで失敗すると「取得に失敗しました」としか見えず、原因が分からない。
 */
async function ensureOllamaRunning(): Promise<boolean> {
  const provider = new OllamaProvider();
  if ((await provider.testConnection()).ok) return true;

  const endpoint = vscode.workspace
    .getConfiguration("novelai")
    .get<string>("ollama.endpoint", "http://localhost:11434");

  const outcome = await withProgress("Ollamaを起動しています…", () =>
    startOllama({ endpoint })
  );
  if (!outcome.ok) {
    vscode.window.showErrorMessage(describeStartFailure(outcome));
    return false;
  }
  return (await provider.testConnection()).ok;
}
