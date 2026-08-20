import * as vscode from "vscode";
import { OllamaProvider } from "../ai/ollamaProvider";
import { OllamaEmbeddingProvider } from "../ai/ollamaEmbedding";
import {
  describeStartFailure,
  resolveExecutable,
  startOllama,
} from "../ai/ollamaLauncher";
import { AIRegistry, runSetupWizard } from "../ai/registry";
import { isGitAvailable } from "../core/git";
import { ghAvailable } from "../core/gitSetup";
import {
  buildSetupPlan,
  RECOMMENDED_CHAT_MODEL,
  RECOMMENDED_EMBEDDING_MODEL,
  REQUIREMENTS,
  totalSizeLabel,
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
import { logFailure, logStep } from "../core/logger";

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
  states.push({ id: "gh", present: await ghAvailable() });

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
  const picked = await vscode.window.showInformationMessage(
    "必要なものはすべて揃っています。",
    configure,
    detail
  );
  if (picked === configure) await runSetupWizard(registry);
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
      : "必要なものは揃っています（任意のものが未導入）";

  const picked = await vscode.window.showQuickPick(items, {
    title: "統合小説執筆環境のセットアップ",
    placeHolder: summary,
    ignoreFocusOut: true,
  });
  await picked?.action();
}

/** 何が要るのかを、用途つきで読める形で出す */
async function showDetail(plan: SetupPlan): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: buildSetupDocument(plan),
  });
  await vscode.window.showTextDocument(document, { preview: true });
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
    const mark = entry.present ? "済" : entry.requirement.level;
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
      entry.present ? "**入っています。**" : `**まだ入っていません**（${entry.requirement.level}）。`,
      ""
    );
    lines.push(entry.requirement.purpose, "");
    if (!entry.present) {
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

  for (const entry of entries) {
    const outcome = await installOne(entry.requirement.id, manager);
    if (outcome.kind === "failed") {
      failures.push(`${entry.requirement.label}: ${outcome.detail}`);
      logFailure("セットアップの導入に失敗", {
        対象: entry.requirement.label,
        理由: outcome.detail,
      });
    }
    if (outcome.kind === "cancelled") {
      vscode.window.showInformationMessage(
        `${entry.requirement.label} の導入を取りやめました。`
      );
      break;
    }
  }

  if (failures.length > 0) {
    const showLog = "ログを見る";
    const picked = await vscode.window.showErrorMessage(
      `一部を入れられませんでした。\n${failures.join("\n")}`,
      showLog
    );
    if (picked === showLog) {
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

  const actions = steps.command
    ? ["コマンドをコピー", "配布ページを開く"]
    : ["配布ページを開く"];
  const answer = await vscode.window.showWarningMessage(
    `${requirement.label} は、ご自身で入れていただく必要があります。`,
    {
      modal: true,
      detail: [
        why,
        "",
        steps.command
          ? `ターミナルで次の1行を実行してください。\n\n  ${steps.command}\n`
          : "",
        steps.note,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    ...actions
  );

  if (answer === "コマンドをコピー" && steps.command) {
    await vscode.env.clipboard.writeText(steps.command);
    void vscode.window.showInformationMessage(
      "コマンドをクリップボードへ入れました。ターミナルへ貼り付けて実行してください。"
    );
  } else if (answer === "配布ページを開く") {
    await vscode.env.openExternal(vscode.Uri.parse(steps.page));
  }

  // 入れ終わったかは分からない。**入ったことにしない**
  return {
    kind: "failed",
    detail:
      "入れ終わったら、もう一度「セットアップ（必要なものを入れる）」を実行してください。",
  };
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
