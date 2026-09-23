import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { isDateKey, type ContestGoal, type WorkGoals } from "../models/workGoals";
import { readWorkGoals, writeWorkGoals } from "../core/workGoalsStore";
import { scanWork } from "../core/scanner";
import { statsDayKey } from "../core/writingStats";
import { logLine, useLogFile } from "../core/logger";
import {
  CONTEST_SOURCE_LABELS,
  parseContestsClipboard,
} from "../core/contestListing";
import {
  asOfLabel,
  charLimitSummary,
  contestChanges,
  goalFromContest,
  localIsoString,
  mergeContestInbox,
  normalizeContestInbox,
  rankContests,
  sameContest,
  storeContests,
  type ContestChange,
  type ContestFit,
  type RankedContest,
  type StoredContest,
} from "../core/contestInbox";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { boundaryHour } from "./writingProgress";
import { reportContest } from "./contestGoalReport";

/**
 * 公募の一覧を取り込み、作品の応募先に選んで入れる（設計書6.3.6.1）。
 *
 * ## 入り口
 *
 * - **ヘルパーから**：一覧のページでアイコンを押すと、ヘルパーが公募を読んで
 *   クリップボードへ置き、`vscode://nonahisa.novel-ai-assistant/import-contests`
 *   を開く。VS Code が前に出て、ここが取り込みを始める
 * - **貼り付けて**：作品目標設定の「公募の一覧を貼り付けて取り込む」。一覧のページの
 *   文を全部選んでコピーしたものを、同じ読み取りで読む
 *
 * どちらも**読むのはクリップボードだけ**で、サイトへは通信しない。
 *
 * ## 募集は書き換わる
 *
 * 締切の延長や字数の変更はよくある。だから：
 *
 * - 応募先には、取り込んだ日時と読んだページを残し、画面に「9月23日時点の情報」と出す
 * - 取り込み直して、応募先に入れた公募の締切・字数が変わっていれば、違いを並べて
 *   **作者に選んで直してもらう**（黙って書き換えない）
 * - 読めなかった件数を必ず言う。**0件を黙って成功にしない**
 */

/** 取り込んだ公募の置き場（`context.globalState` の鍵） */
export const CONTEST_INBOX_KEY = "novelai.contests.inbox";

/**
 * 「締切までに届きそう」とみなす1日の字数の目安。作者が1日の目標
 * （`novelai.stats.dailyGoal`）を決めていればそちらを使う。
 */
export const DEFAULT_CONTEST_PACE = 2000;

/** 原稿用紙換算の断り（作者の依頼の文言のまま） */
export const MANUSCRIPT_NOTE = "原稿用紙換算は目安です。応募要項で確かめてください。";

/** 覚え書きの置き場（`vscode.Memento` のうち使う分だけ） */
export interface ContestMemory {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ContestImportDeps {
  readonly memory: ContestMemory;
  /** 登録された作品（取り込み直したときの違いを探す・応募先を入れる作品を選ぶ） */
  listWorks(): readonly WorkEntry[];
  /** 応募先を書き換えたあと（執筆量パネルを作り直す） */
  afterSave(work: WorkEntry): Promise<void>;
}

/** 貼り付けて取り込むときの案内（ヘルパーの読み取りがうまくいかなかったときにも出す） */
const PASTE_GUIDE =
  "一覧のページで文章を全部選んでコピー（Ctrl+A → Ctrl+C）し、" +
  "「作品目標設定」→「公募の一覧を貼り付けて取り込む」から入れてください。";

function todayKey(): string {
  return statsDayKey(new Date(), boundaryHour());
}

export function loadContestInbox(memory: ContestMemory): StoredContest[] {
  return normalizeContestInbox(memory.get<unknown>(CONTEST_INBOX_KEY, []));
}

/**
 * クリップボードの公募の一覧を取り込む。
 *
 * @param trigger `uri`：ヘルパーから呼ばれた／`paste`：作者が貼り付けを押した
 * @param work 貼り付けを作品目標設定から押したときの作品（取り込んだあと、そのまま選ぶ）
 */
export async function importContestsFromClipboard(
  deps: ContestImportDeps,
  trigger: "uri" | "paste",
  work?: WorkEntry
): Promise<void> {
  let text: string;
  try {
    text = await vscode.env.clipboard.readText();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useLogFile(undefined);
    logLine(`公募の一覧を取り込むためにクリップボードを読めませんでした：${message}`);
    void vscode.window.showWarningMessage(
      "クリップボードを読めなかったため、公募の一覧を取り込めませんでした。"
    );
    return;
  }

  const parsed = parseContestsClipboard(text);
  if (!parsed.ok) {
    if (parsed.kind === "invalid") {
      void vscode.window.showWarningMessage(parsed.reason);
      return;
    }
    // 公募の一覧でない。**中身は記録にも残さない**（クリップボードは作者の私物）
    void vscode.window.showInformationMessage(
      trigger === "uri"
        ? "クリップボードに公募の一覧がありませんでした。統合小説執筆環境ヘルパーで公募の一覧のページを開き、" +
            "アイコンを押してからもう一度お試しください。うまくいかないときは、" +
            PASTE_GUIDE
        : "クリップボードに公募の一覧が見つかりませんでした。" + PASTE_GUIDE
    );
    return;
  }

  useLogFile(undefined);
  logLine(
    `公募の一覧を取り込みます（${parsed.from === "helper" ? "ヘルパーから" : "貼り付け"}）：` +
      `読めた${parsed.listings.length}件・公募として読めなかった${parsed.skipped}件` +
      (parsed.pageUrl ? `（${parsed.pageUrl}）` : "")
  );

  // **0件を黙って成功にしない**（サイトの作りが変わって読めなかったとき）
  if (parsed.listings.length === 0) {
    void vscode.window.showWarningMessage(
      `公募を1件も読めませんでした（読めなかったもの ${parsed.skipped}件）。` +
        "ページの作りが変わったのかもしれません。" +
        PASTE_GUIDE
    );
    return;
  }

  const today = todayKey();
  const incoming = storeContests(parsed.listings, {
    importedAt: parsed.readAt ?? localIsoString(new Date()),
    sourcePage: parsed.pageUrl,
  });
  const merged = mergeContestInbox(loadContestInbox(deps.memory), incoming, today);
  await deps.memory.update(CONTEST_INBOX_KEY, merged.inbox);

  const summary = importSummary(parsed.listings.length, parsed.skipped, incoming, merged.droppedPast);

  // 応募先に入れた公募が取り込み直されていれば、違いを知らせる（作者が選んで直す）
  await offerChangedGoals(deps, incoming, today);

  if (work) {
    void vscode.window.showInformationMessage(summary);
    await chooseContestForWork(work, deps);
    return;
  }
  const works = deps.listWorks();
  if (works.length === 0) {
    void vscode.window.showInformationMessage(
      summary + "作品を登録すると、作品目標設定から応募先に選べます。"
    );
    return;
  }
  const answer = await vscode.window.showInformationMessage(
    summary,
    "応募先に選ぶ",
    "あとで選ぶ"
  );
  if (answer !== "応募先に選ぶ") return;
  const target = works.length === 1 ? works[0] : await askWork(works);
  if (target) await chooseContestForWork(target, deps);
}

/**
 * 取り込んだ結果を1つの文にする。**読めなかったものの数を必ず言う**
 * （公募として読めなかった・締切を読めなかった・字数を読めなかった）。
 */
export function importSummary(
  read: number,
  skipped: number,
  incoming: readonly StoredContest[],
  droppedPast: number
): string {
  const noDeadline = incoming.filter((entry) => entry.deadlines.length === 0).length;
  const noChars = incoming.filter((entry) => entry.charLimit.kind === "unreadable").length;
  const parts = [`公募を${read}件読みました`];
  if (skipped > 0) parts.push(`（公募として読めなかったもの ${skipped}件）`);
  parts.push("。");
  if (droppedPast > 0) parts.push(`締切の過ぎた${droppedPast}件は除きました。`);
  if (noDeadline > 0 || noChars > 0) {
    const unread = [
      noDeadline > 0 ? `締切を読めなかったもの ${noDeadline}件` : "",
      noChars > 0 ? `字数を読めなかったもの ${noChars}件` : "",
    ].filter(Boolean);
    parts.push(`${unread.join("・")}は、選ぶときに原文を見て入れてください。`);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// 取り込み直したときの違い
// ---------------------------------------------------------------------------

const CHANGE_LABELS: Record<ContestChange["field"], string> = {
  deadline: "締切",
  minChars: "下限",
  maxChars: "上限",
};

function changeValue(change: ContestChange, value: string | number | null): string {
  if (value === null) return "なし";
  if (typeof value === "number") return `${value.toLocaleString("ja-JP")}字`;
  return value;
}

/**
 * 応募先に入れてある公募が、取り込み直した一覧で変わっていれば、作品ごとに知らせる。
 * **黙って書き換えない**——どれを直すかは作者が選ぶ。
 */
async function offerChangedGoals(
  deps: ContestImportDeps,
  incoming: readonly StoredContest[],
  today: string
): Promise<void> {
  for (const work of deps.listWorks()) {
    let goals: WorkGoals;
    try {
      goals = await readWorkGoals(work);
    } catch {
      // 壊れた目標のファイルは、ここでは触らない（作品目標設定を開いたときに理由が出る）
      continue;
    }
    const contest = goals.contest;
    if (!contest) continue;
    for (const entry of incoming) {
      const changes = contestChanges(contest, entry, today);
      if (!changes || changes.length === 0) continue;
      await offerChanges(deps, work, goals, contest, entry, changes);
      break;
    }
  }
}

async function offerChanges(
  deps: ContestImportDeps,
  work: WorkEntry,
  goals: WorkGoals,
  contest: ContestGoal,
  entry: StoredContest,
  changes: readonly ContestChange[]
): Promise<void> {
  const before = contest.imported ? asOfLabel(contest.imported.importedAt) : "手で入れた情報";
  const lines = changes.map(
    (change) =>
      `${CHANGE_LABELS[change.field]}：${changeValue(change, change.before)} → ${changeValue(change, change.after)}`
  );
  const buttons = ["選んで直す", ...(entry.url ? ["募集要項を開く"] : [])];
  for (;;) {
    const answer = await vscode.window.showWarningMessage(
      `「${work.title}」の応募先「${contest.name}」の募集内容が、いま取り込んだ一覧と違います。`,
      {
        modal: true,
        detail:
          `${lines.join("\n")}\n\n` +
          `応募先は${before}です。いま取り込んだのは${asOfLabel(entry.importedAt)}です。` +
          "直すものを選んでください（直さなければ、応募先はそのままです）。",
      },
      ...buttons
    );
    if (answer === "募集要項を開く" && entry.url) {
      await vscode.env.openExternal(vscode.Uri.parse(entry.url));
      continue;
    }
    if (answer !== "選んで直す") return;
    break;
  }

  const picked = await vscode.window.showQuickPick(
    changes.map((change, index) => ({
      label: lines[index],
      picked: true,
      change,
    })),
    {
      title: `「${contest.name}」の直すものを選ぶ`,
      placeHolder: "印を付けたものだけを直します（印を外したものは、いまの応募先のまま）",
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked || picked.length === 0) return;

  const next: ContestGoal = { ...contest };
  for (const { change } of picked) {
    if (change.field === "deadline" && typeof change.after === "string") {
      next.deadline = change.after;
    }
    if (change.field === "minChars") next.minChars = change.after as number | null;
    if (change.field === "maxChars") next.maxChars = change.after as number | null;
  }
  if (next.minChars !== null && next.maxChars !== null && next.minChars > next.maxChars) {
    void vscode.window.showWarningMessage(
      "下限が上限を超えてしまうため、直しませんでした。作品目標設定で確かめてください。"
    );
    return;
  }
  // **全部を直したときだけ**「いつの情報か」を新しくする。一部だけなら、
  // 直さなかった値は前の情報のままなので、日付を進めると嘘になる
  if (picked.length === changes.length) {
    next.imported = goalFromContest(entry, {
      deadline: next.deadline,
      minChars: next.minChars,
      maxChars: next.maxChars,
    }).imported;
    next.url = entry.url ?? entry.sourcePage ?? contest.url;
  }
  if (await saveGoals(work, { ...goals, contest: next })) {
    await deps.afterSave(work);
    void vscode.window.showInformationMessage(
      `「${work.title}」の応募先「${contest.name}」を直しました。`
    );
  }
}

// ---------------------------------------------------------------------------
// 応募先に選ぶ
// ---------------------------------------------------------------------------

const FIT_HEADINGS: Record<ContestFit, (pace: number) => string> = {
  fits: () => "いまの字数で応募できる",
  reachable: (pace) => `締切までに下限へ届きそう（1日${pace.toLocaleString("ja-JP")}字の目安）`,
  unknownChars: () => "字数を読めなかったもの（原文を見て決める）",
  far: () => "下限まで遠いもの",
  over: () => "いまの字数が上限を超えているもの",
  noDeadline: () => "締切を読めなかったもの（随時募集など）",
};

type ContestPick = vscode.QuickPickItem & { ranked?: RankedContest };

/**
 * 取り込んだ公募から、作品の応募先を選ぶ。
 *
 * 並びは**いまの字数に合うものを上に、その中は締切の近い順**。締切の過ぎたものは出さない。
 * 選んだあと、**1件ずつ中身（賞典・字数の原文・主催・募集作品・応募資格）を確かめてから**入れる。
 *
 * @returns 応募先を入れたか
 */
export async function chooseContestForWork(
  work: WorkEntry,
  deps: ContestImportDeps
): Promise<boolean> {
  const inbox = loadContestInbox(deps.memory);
  if (inbox.length === 0) {
    const answer = await vscode.window.showInformationMessage(
      "取り込んだ公募がありません。統合小説執筆環境ヘルパーで公募の一覧のページを開いてアイコンを押すか、" +
        "一覧のページの文章を全部選んでコピーしてから「貼り付けて取り込む」を押してください。",
      "貼り付けて取り込む"
    );
    if (answer === "貼り付けて取り込む") {
      await importContestsFromClipboard(deps, "paste", work);
    }
    return false;
  }

  let written = 0;
  try {
    written = (await scanWork(work)).stats.totals.net;
  } catch {
    // 数えられなくても選べる（並びが「0字」のときの並びになるだけ）
  }
  const configured = vscode.workspace
    .getConfiguration("novelai")
    .get<number>("stats.dailyGoal", 0);
  const pace = configured > 0 ? configured : DEFAULT_CONTEST_PACE;
  const ranked = rankContests(inbox, { written, todayKey: todayKey(), pacePerDay: pace });
  if (ranked.length === 0) {
    void vscode.window.showInformationMessage(
      "取り込んだ公募は、どれも締切が過ぎています。新しい一覧を取り込んでください。"
    );
    return false;
  }

  const items: ContestPick[] = [];
  let heading: ContestFit | undefined;
  for (const entry of ranked) {
    if (entry.fit !== heading) {
      heading = entry.fit;
      items.push({ label: FIT_HEADINGS[entry.fit](pace), kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({
      label: entry.contest.name,
      description:
        entry.deadline !== null
          ? `締切 ${entry.deadline}（あと${entry.daysLeft}日）`
          : `締切：${entry.contest.deadlineText || "記載なし"}`,
      detail: [
        charLimitSummary(entry.contest.charLimit),
        entry.neededPerDay !== null && entry.fit !== "fits"
          ? `下限まで1日${entry.neededPerDay.toLocaleString("ja-JP")}字`
          : "",
        entry.contest.organizer ? `主催：${entry.contest.organizer}` : "",
        `${CONTEST_SOURCE_LABELS[entry.contest.source]}・${asOfLabel(entry.contest.importedAt)}`,
      ]
        .filter(Boolean)
        .join("　"),
      ranked: entry,
    });
  }
  const picked = await vscode.window.showQuickPick([...items, cancelItem()], {
    title: `「${work.title}」の応募先を選ぶ（いま ${written.toLocaleString("ja-JP")}字）`,
    placeHolder: "公募の名前・主催で絞り込めます",
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked) || !("ranked" in picked) || !picked.ranked) return false;
  return confirmAndSave(work, picked.ranked, deps);
}

/** 選んだ公募の中身を見せて、確かめてから入れる */
async function confirmAndSave(
  work: WorkEntry,
  ranked: RankedContest,
  deps: ContestImportDeps
): Promise<boolean> {
  const contest = ranked.contest;
  const readable = ranked.deadline !== null && contest.charLimit.kind !== "unreadable";
  const buttons = [
    ...(readable ? ["応募先に入れる"] : []),
    readable ? "締切・字数を直して入れる" : "締切・字数を入れて入れる",
    ...(contest.url ? ["募集要項を開く"] : []),
  ];

  let answer: string | undefined;
  for (;;) {
    answer = await vscode.window.showInformationMessage(
      `「${contest.name}」を「${work.title}」の応募先に入れますか？`,
      { modal: true, detail: contestDetail(ranked) },
      ...buttons
    );
    if (answer === "募集要項を開く" && contest.url) {
      await vscode.env.openExternal(vscode.Uri.parse(contest.url));
      continue;
    }
    break;
  }
  if (!answer) return false;

  let values: { deadline: string; minChars: number | null; maxChars: number | null } | undefined;
  if (answer === "応募先に入れる" && ranked.deadline !== null) {
    const limit = contest.charLimit;
    values = {
      deadline: ranked.deadline,
      minChars: limit.kind === "range" ? limit.min : null,
      maxChars: limit.kind === "range" ? limit.max : null,
    };
  } else {
    values = await askValues(ranked);
  }
  if (!values) return false;

  let goals: WorkGoals;
  try {
    goals = await readWorkGoals(work);
  } catch (error) {
    // **壊れた目標のファイルを上書きしない**（作者が書いた値が消える）
    void vscode.window.showErrorMessage(
      `目標のファイル（.aiwriter/goals.json）を読めないため、応募先を入れませんでした：${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }

  const current = goals.contest;
  const same =
    current !== null &&
    sameContest({ name: current.name, organizer: current.imported?.organizer ?? null }, contest);
  if (current && !same) {
    const replace = await vscode.window.showWarningMessage(
      `いまの応募先「${current.name}」を「${contest.name}」に置き換えますか？`,
      { modal: true, detail: "置き換えると、前の応募先の締切・字数・日間目標は消えます。" },
      "置き換える"
    );
    if (replace !== "置き換える") return false;
  }

  const next = goalFromContest(contest, values);
  // 同じ公募を入れ直すときは、作者が決めた日間目標を残す
  if (same && current) next.dailyGoal = current.dailyGoal;
  if (!(await saveGoals(work, { ...goals, contest: next }))) return false;
  await deps.afterSave(work);
  await reportContest(work, next);
  return true;
}

/** 確かめる画面の中身。**原文を並べる**（読み替えは目安で、決めるのは作者） */
export function contestDetail(ranked: RankedContest): string {
  const contest = ranked.contest;
  const limit = contest.charLimit;
  const lines: string[] = [];
  lines.push(
    `締切：${contest.deadlineText || "記載なし"}` +
      (ranked.deadline !== null ? `（${ranked.deadline}）` : "（日付を読めませんでした）")
  );
  lines.push(
    `字数：${contest.charText || "記載なし"}` +
      `（${charLimitSummary(limit)}${limit.kind === "unreadable" ? `。${limit.reason}` : ""}）`
  );
  if (limit.kind === "range" && limit.converted) lines.push(MANUSCRIPT_NOTE);
  const fields: [string, string | null][] = [
    ["賞典", contest.prize],
    ["主催", contest.organizer],
    ["選考", contest.judges],
    ["募集作品", contest.genre],
    ["応募資格", contest.eligibility],
    ["応募料", contest.fee],
  ];
  for (const [label, value] of fields) {
    if (value) lines.push(`${label}：${value}`);
  }
  lines.push("");
  lines.push(
    `${asOfLabel(contest.importedAt)}（${CONTEST_SOURCE_LABELS[contest.source]}）。` +
      "募集は変わることがあります。応募の前に募集要項で確かめてください。"
  );
  return lines.join("\n");
}

/** 締切・下限・上限を作者に入れてもらう（読めた値を初めから入れておく。原文を添える） */
async function askValues(
  ranked: RankedContest
): Promise<{ deadline: string; minChars: number | null; maxChars: number | null } | undefined> {
  const contest = ranked.contest;
  const limit = contest.charLimit;
  const deadline = await askText({
    title: `締切日（${contest.name}）`,
    prompt: `YYYY-MM-DD の形で入れてください。原文：${contest.deadlineText || "記載なし"}`,
    value: ranked.deadline ?? "",
    placeHolder: "2026-10-31",
    validateInput: (value) =>
      isDateKey(value.trim()) ? null : "YYYY-MM-DD の形で入れてください（例: 2026-10-31）",
  });
  if (deadline === undefined) return undefined;

  const charNote =
    `原文：${contest.charText || "記載なし"}` +
    (limit.kind === "range" && limit.converted ? `。${MANUSCRIPT_NOTE}` : "");
  const min = await askText({
    title: `作品の文字量の下限（${contest.name}）`,
    prompt: `無ければ空のまま。${charNote}`,
    value: limit.kind === "range" && limit.min !== null ? String(limit.min) : "",
    validateInput: validateOptionalCount,
  });
  if (min === undefined) return undefined;
  const max = await askText({
    title: `作品の文字量の上限（${contest.name}）`,
    prompt: `無ければ空のまま。${charNote}`,
    value: limit.kind === "range" && limit.max !== null ? String(limit.max) : "",
    validateInput: (value) => {
      const basic = validateOptionalCount(value);
      if (basic) return basic;
      if (value.trim() && min.trim() && Number(value.trim()) < Number(min.trim())) {
        return "下限より小さい値は入れられません";
      }
      return null;
    },
  });
  if (max === undefined) return undefined;
  return {
    deadline: deadline.trim(),
    minChars: min.trim() ? Number(min.trim()) : null,
    maxChars: max.trim() ? Number(max.trim()) : null,
  };
}

function validateOptionalCount(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/u.test(trimmed)) return "半角の数字で入れてください";
  if (Number(trimmed) <= 0) return "1以上で入れてください";
  return null;
}

async function saveGoals(work: WorkEntry, goals: WorkGoals): Promise<boolean> {
  try {
    await writeWorkGoals(work, goals);
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(
      `目標を保存できませんでした: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

async function askWork(works: readonly WorkEntry[]): Promise<WorkEntry | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...works.map((entry) => ({ label: entry.title, description: entry.folderPath, work: entry })),
      cancelItem("あとで選ぶ（作品目標設定から選べます）"),
    ],
    {
      title: "応募先を選ぶ作品（一覧から選びます）",
      placeHolder: "取り込んだ公募から、どの作品の応募先を選びますか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("work" in picked)) return undefined;
  return picked.work;
}
