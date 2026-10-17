import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { ASSIGNABLE_FEATURES, ASSIGNABLE_FEATURE_LABELS, type AIRegistry } from "../ai/registry";
import { atomicWriteFile } from "../core/atomicWrite";
import { CharacterStore } from "../core/characterStore";
import {
  ISSUE_REPORT_DIR,
  ISSUE_REPORT_LOG_FILES,
  ISSUE_REPORT_RANGES,
  buildIssueReport,
  makeIssueReportId,
  type IssueReport,
  type IssueReportAi,
  type IssueReportInput,
  type IssueReportLog,
} from "../core/issueReport";
import { isLocalProviderId } from "../core/localProviders";
import { redactSecrets, workLog } from "../core/logger";
import { environmentVariable, hostPlatform, isWebRuntime } from "../core/runtime";
import { revealFolder } from "../views/openDocument";
import { confirmRunOrChoose, notifyDone } from "../views/notify";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 障害報告用の記録を書き出す（設計書8.5。作者の裁定 2026-10-17）。
 *
 * 記録の組み立てと伏せ方は `core/issueReport.ts`。ここは画面と読み書きだけを持つ。
 *
 * **送る口は作らない。** Webhook も外への送信も無い。作者が要約を写して
 * Discord の `/不具合を報告` に貼り、ファイルを添付する——何が外へ出るかを
 * 作者が最後に目で確かめられる形にするため。
 */

export interface ExportIssueReportOptions {
  context: vscode.ExtensionContext;
  aiRegistry: AIRegistry;
  works: readonly WorkEntry[];
  /** 迷いようが無いときに決まっている作品（右クリック・開いている原稿・登録が1つ） */
  preferred: WorkEntry | undefined;
  /** 作品が決まらないときの置き場（拡張機能の保管庫。`actions.log` の予備の置き場と同じ根） */
  storageRoot: string | undefined;
}

/** 選ぶ一覧で「作品を選ばない」を表す印 */
const NO_WORK = Symbol("no-work");

export async function exportIssueReport(options: ExportIssueReportOptions): Promise<void> {
  const work = await chooseWork(options);
  if (work === undefined) return;
  const target = work === NO_WORK ? undefined : work;

  const range = await chooseRange();
  if (!range) return;

  const root = target?.folderPath ?? options.storageRoot;
  if (!root) {
    void vscode.window.showWarningMessage(
      "記録の置き場所が決まりませんでした。作品を登録してから、もう一度お試しください。"
    );
    return;
  }

  const now = new Date();
  const base = await gatherInput(options, target, range, now);

  const answer = await confirm(buildIssueReport(base), base, target);
  if (!answer) return;
  // 作者が外したときだけ、人物名・作品名を伏せずに組み直す（同じ報告ID のまま）
  const chosen: IssueReportInput =
    answer === "unmasked"
      ? { ...base, redaction: { ...base.redaction, maskNames: false } }
      : base;

  const written = await writeReport(root, chosen);
  if (!written) return;

  workLog(target?.folderPath).line(
    `障害報告用の記録を書き出した: ${written.report.reportId}（${range.label}）`
  );
  showDone(written.filePath, written.report);
}

async function chooseWork(
  options: ExportIssueReportOptions
): Promise<WorkEntry | typeof NO_WORK | undefined> {
  if (options.preferred) return options.preferred;
  if (options.works.length === 0) return NO_WORK;

  type Item = vscode.QuickPickItem & { value?: WorkEntry | typeof NO_WORK };
  const items: Item[] = [
    ...options.works.map((entry) => ({ label: entry.title, value: entry })),
    {
      label: "作品を選ばない",
      description: "作品をまたぐ操作の記録だけを書き出す",
      value: NO_WORK,
    },
  ];
  const picked = await vscode.window.showQuickPick<Item>([...items, cancelItem()], {
    title: "障害報告用の記録：どの作品の記録を書き出すか",
    placeHolder: "不具合が起きた作品を選んでください",
  });
  if (!picked || isCancelItem(picked)) return undefined;
  return picked.value;
}

async function chooseRange(): Promise<{ hours: number; label: string } | undefined> {
  type Item = vscode.QuickPickItem & { value?: { hours: number; label: string } };
  const items: Item[] = ISSUE_REPORT_RANGES.map((range, index) => ({
    label: range.label,
    description: index === 0 ? "既定" : undefined,
    value: range,
  }));
  const picked = await vscode.window.showQuickPick<Item>([...items, cancelItem()], {
    title: "障害報告用の記録：どこまでさかのぼるか",
    placeHolder: "不具合が起きた時刻を含む範囲を選んでください",
  });
  if (!picked || isCancelItem(picked)) return undefined;
  return picked.value;
}

async function readText(location: string): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(location));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined; // まだ記録が無い（初めて使う作品など）
  }
}

const LOG_LABELS: Record<(typeof ISSUE_REPORT_LOG_FILES)[number], string> = {
  "actions.log": "動作の記録（作品）",
  "ai_actions.log": "指摘の採否（作品）",
};

async function gatherInput(
  options: ExportIssueReportOptions,
  work: WorkEntry | undefined,
  range: { hours: number; label: string },
  now: Date
): Promise<IssueReportInput> {
  const logs: IssueReportLog[] = [];
  if (work) {
    for (const fileName of ISSUE_REPORT_LOG_FILES) {
      const text = await readText(path.join(work.folderPath, ".aiwriter", "logs", fileName));
      if (text !== undefined) logs.push({ label: LOG_LABELS[fileName], fileName, text });
    }
  }
  // 作品をまたぐ操作（接続の確認・AIチューニングなど）は保管庫の記録に残っている
  if (options.storageRoot && (!work || !path.isSamePath(options.storageRoot, work.folderPath))) {
    const text = await readText(path.join(options.storageRoot, ".aiwriter", "logs", "actions.log"));
    if (text !== undefined) {
      logs.push({ label: "動作の記録（作品をまたぐ操作）", fileName: "actions.log", text });
    }
  }

  const characters: string[][] = [];
  if (work) {
    try {
      const loaded = await new CharacterStore(work).loadAll();
      for (const character of loaded.characters) {
        characters.push([
          character.name,
          ...character.aliases,
          // 読み仮名は短いとありふれた語に当たるので、3字以上だけ
          ...(character.reading && Array.from(character.reading).length >= 3
            ? [character.reading]
            : []),
        ]);
      }
    } catch {
      // 台帳が読めなくても書き出しは止めない（作品名と本文の伏せ方は効く）
    }
  }

  const namesOf = (entry: WorkEntry): string[] => [entry.title, path.basename(entry.folderPath)];
  const packageJson = options.context.extension.packageJSON as { version?: string };

  return {
    now,
    reportId: makeIssueReportId(now),
    rangeHours: range.hours,
    rangeLabel: range.label,
    environment: {
      extensionVersion: packageJson.version ?? "（不明）",
      vscodeVersion: vscode.version,
      os: hostPlatform(),
      browser: isWebRuntime(),
      ais: describeAis(options.aiRegistry),
    },
    logs,
    redaction: {
      workRoot: work?.folderPath,
      storageRoot: options.storageRoot,
      homeDir: environmentVariable("USERPROFILE") ?? environmentVariable("HOME"),
      characters,
      workNames: work ? namesOf(work) : [],
      otherWorkNames: options.works
        .filter((entry) => entry.id !== work?.id)
        .flatMap(namesOf),
      maskNames: true,
      redactSecrets,
    },
  };
}

/**
 * 使っているAI。既定と、機能ごとに割り当てた分。**URL は渡さない**
 * （手元かクラウドかだけで切り分けには足りる。接続先は作者の環境の情報）。
 */
function describeAis(registry: AIRegistry): IssueReportAi[] {
  const ais: IssueReportAi[] = [];
  const add = (label: string, resolved: ReturnType<AIRegistry["resolve"]>): void => {
    if (!resolved) return;
    ais.push({
      label,
      provider: resolved.provider.displayName,
      model: resolved.model,
      local: isLocalProviderId(resolved.provider.id),
    });
  };
  add("既定", registry.resolve("default"));
  const assigned = registry.assignments();
  for (const feature of ASSIGNABLE_FEATURES) {
    if (assigned[feature]) add(ASSIGNABLE_FEATURE_LABELS[feature], registry.resolve(feature));
  }
  return ais;
}

/**
 * 書き出す前に、何を入れて何を伏せるかを見せる。
 * 人物名・作品名を伏せずに書き出す道もここで選べる（作者の裁定：既定は伏せる）。
 */
async function confirm(
  report: IssueReport,
  input: IssueReportInput,
  work: WorkEntry | undefined
): Promise<"masked" | "unmasked" | undefined> {
  const lines = report.lineCounts
    .map((count) => `・${count.label}：${count.lines}行${count.dropped > 0 ? `（古い${count.dropped}行は省く）` : ""}`)
    .join("\n");
  const detail = [
    `報告ID：${report.reportId}`,
    "",
    "入れるもの",
    "・環境：拡張機能とVS Codeの版・OS・使っているAIの種類とモデル（手元かクラウドか）",
    `・${input.rangeLabel}の記録`,
    lines || "・（この範囲の記録はありません）",
    `・失敗のまとめ：${report.failureCount}件`,
    "",
    "伏せるもの",
    `・原稿の本文と抜粋 → 〈本文 n字〉（${report.stats.body + report.stats.longRuns}か所）`,
    `・AIの応答 → 〈応答 n字〉（${report.stats.response}か所。JSONは骨組みだけ）`,
    `・人物名・作品名 → 〈人物A〉〈作品〉（${report.stats.names}か所）`,
    "・APIの鍵・URL・あなたのフォルダー名",
    "",
    "入れないもの",
    "・相談のやり取り",
    "",
    `置き場所：${work ? "作品の" : "拡張機能の保管庫の"} .aiwriter/reports/${report.fileName}（GitHubへは送りません）`,
    "外へは送りません。書き出したあと、Discord へ手で貼ってください。",
  ].join("\n");

  // 確認は画面上部の選択窓で（作者の裁定 A4。`confirmRunOrChoose`）
  const unmasked = "人物名・作品名を伏せずに書き出す";
  const answer = await confirmRunOrChoose("障害報告用の記録を書き出しますか？", "書き出す", {
    detail,
    work,
    choices: [unmasked],
  });
  if (answer?.kind === "run") return "masked";
  if (answer?.kind === "choice" && answer.label === unmasked) return "unmasked";
  return undefined;
}

/**
 * 新しいファイルとして置く（既存のファイルは上書きしない。`atomicWriteFile` の
 * `create`）。同じ名前があれば報告ID を作り直す——IDは書き出すたびに作るもので、
 * 重なったのは4字の乱数がたまたま当たったときだけ。
 */
async function writeReport(
  root: string,
  input: IssueReportInput
): Promise<{ filePath: string; report: IssueReport } | undefined> {
  const dir = path.join(root, ".aiwriter", ISSUE_REPORT_DIR);
  let current = input;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const report = buildIssueReport(current);
    const filePath = path.join(dir, report.fileName);
    try {
      await vscode.workspace.fs.createDirectory(path.toUri(dir));
      await atomicWriteFile(filePath, new TextEncoder().encode(report.document), {
        mode: "create",
      });
      return { filePath, report };
    } catch (error) {
      lastError = error;
      // 範囲（いつからいつまで）は確認で見せたものから動かさず、IDだけ作り直す
      current = { ...current, reportId: makeIssueReportId(new Date()) };
    }
  }
  workLog(input.redaction.workRoot).failure("障害報告用の記録を書き出せなかった", {
    置き場所: dir,
    詳細: lastError instanceof Error ? lastError.message : String(lastError),
  });
  void vscode.window.showWarningMessage(
    "障害報告用の記録を書き出せませんでした。詳しくはログ表示を開いてください。"
  );
  return undefined;
}

/**
 * 書き出したあとの案内。ボタンは2つ（［要約をコピー］［ファイルの場所を開く］）。
 *
 * **答えを await して止まらない**（モーダルでない知らせを待つと、作者が押さずに
 * 置いたときに処理が終わらない）。押されたら後から動き、もう一方のボタンも
 * 押せるように同じ案内を出し直す。
 */
function showDone(filePath: string, report: IssueReport): void {
  const copy = "要約をコピー";
  const reveal = "ファイルの場所を開く";
  const message =
    `障害報告用の記録を書き出しました（${report.reportId}）。` +
    "Discord の /不具合を報告 に貼ってください（詳細はファイルを添付）。";
  void vscode.window.showInformationMessage(message, copy, reveal).then(async (picked) => {
    if (picked === copy) {
      await vscode.env.clipboard.writeText(report.summary);
      notifyDone("要約をコピーしました。入力窓の欄ごとに貼ってください。");
      showDone(filePath, report);
    } else if (picked === reveal) {
      await revealFolder(filePath);
      showDone(filePath, report);
    }
  });
}
