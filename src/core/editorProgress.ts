/**
 * 編集者メニューの進み具合（作者の指示 2026-11-05 夜「作品名等や進捗ステータスも
 * わかりやすくしたいです」。設計書5.6.6）。
 *
 * 各手順に「済み／次はここ／まだ」の印を付け、上に状態の行（校閲中の話・置いた提案・
 * 作者の採否・受け取り）を出す。**判定はここ1か所で、VS Code に依らない**
 * （画面は `views/editorMenu.ts`、読み集めは `features/editorMenuFacts.ts`）。
 *
 * ## 決まりの芯
 *
 * - **新しい記録を作らない。** 既にある台帳（受け取り待ちの数・校閲の鍵・提案の台帳・
 *   送っていない変更・採否の覚え）だけから決める。進み具合のための記録を別に持つと、
 *   台帳と食い違ったときにどちらが正しいか分からない
 * - **分からないものは「済み」にしない**（作者の指示）。ブラウザ版や GitHub の状態が
 *   読めないときは、受け取り・返したかは「まだ」のまま
 * - **周回を区切る。** 提案の台帳は回をまたいで溜まるので、そのまま数えると2回目の校閲が
 *   始まった時点で「3. 機械に探させる」も「4. 直しを提案する」も済みに見える。
 *   いま押さえている校閲の鍵のうち、いちばん古い時刻からを「この回」とする
 */
import type { FileLock } from "../models/fileLock";
import {
  decisionKey,
  describeDecisionCounts,
  isHandCategory,
  summarizeDecisions,
  type ProposalView,
} from "../models/proposal";
import type { EditorStepKey } from "./stepDefs";

/** 手順の並び（画面の順と同じ） */
export const EDITOR_STEP_ORDER: readonly EditorStepKey[] = [
  "receive",
  "range",
  "detect",
  "propose",
  "review",
  "return",
  "decisions",
];

export type EditorStepMark = "done" | "next" | "todo";

/** 判定に使う事実。**読めなかったものは undefined のまま渡す** */
export interface EditorProgressFacts {
  /**
   * GitHub との差（その作品の分）。読めないとき（ブラウザ版・Git の無い作品・
   * まだ一度も確かめていない）は undefined
   */
  sync?: {
    /** まだ受け取っていない作者の記録の数 */
    behind: number;
    /** 送っていない記録の数 */
    ahead: number;
    /** 記録していない変更のあるファイルの数（提案を置くと増える） */
    dirty: number;
  };
  /** 自分が押さえている校閲の鍵（自分の名前が読めないときは編集者の鍵すべて） */
  myLocks: readonly FileLock[];
  /** 自分が置いた提案（名前が読めないときは台帳の提案すべて） */
  myProposals: readonly ProposalView[];
  /** もう知らせた・見た採否の鍵（`decisionKey`） */
  seenDecisions: ReadonlySet<string>;
  /** 最後に作者の原稿を受け取った時刻（ISO 8601）。分からなければ undefined */
  lastReceivedAt?: string;
}

/** 返したかの見立て */
export type EditorRoundPhase =
  /** 校閲の途中（または、まだ何も始めていない） */
  | "reviewing"
  /** この回の提案を作者へ返し終えた */
  | "returned";

export interface EditorProgress {
  phase: EditorRoundPhase;
  marks: Record<EditorStepKey, EditorStepMark>;
  /** 「次はここ」の手順。無ければ undefined（すべて済み・作者の返事待ち） */
  next?: EditorStepKey;
  /** 印の横に添える一言（「未取得 2」など）。無ければ空 */
  notes: Record<EditorStepKey, string>;
  /** この回に置いた提案の数（返したあとは0） */
  roundProposals: number;
  /** 作者がまだ決めていない自分の提案の数 */
  awaitingAuthor: number;
  /** 届いているのに、まだ知らせていない・見ていない採否の数 */
  unseenDecisions: number;
}

/** 送っていない変更があるか。**読めなければ undefined**（あるとも無いとも言わない） */
function hasUnsent(sync: EditorProgressFacts["sync"]): boolean | undefined {
  if (!sync) return undefined;
  return sync.ahead > 0 || sync.dirty > 0;
}

/**
 * この回に置いた提案。
 *
 * - 返し終えたあと：0件（次の回はまだ始まっていない）
 * - 鍵を押さえている：鍵のいちばん古い時刻より後に置いた、まだ作者が決めていない提案
 * - 鍵が無く、送っていない変更がある：まだ決まっていない提案（鍵を掛けずに置いた回）
 * - 鍵が無く、GitHub の状態も読めない：**数えない**（前の回の提案と見分けられない）
 */
function roundProposalsOf(
  facts: EditorProgressFacts,
  returned: boolean
): ProposalView[] {
  if (returned) return [];
  const pending = facts.myProposals.filter((view) => view.status === "pending");
  if (facts.myLocks.length > 0) {
    const start = earliest(facts.myLocks.map((lock) => lock.since));
    if (start === undefined) return pending;
    return pending.filter((view) => {
      const at = Date.parse(view.time);
      return Number.isNaN(at) || at >= start;
    });
  }
  return hasUnsent(facts.sync) === true ? pending : [];
}

function earliest(times: readonly string[]): number | undefined {
  const parsed = times.map((time) => Date.parse(time)).filter((value) => !Number.isNaN(value));
  return parsed.length > 0 ? Math.min(...parsed) : undefined;
}

/**
 * 進み具合を決める。表は設計書5.6.6。
 *
 * | 手順 | 済み |
 * |---|---|
 * | 1 受け取る | GitHub の状態が読めて、未取得が0 |
 * | 2 話を選ぶ | 自分の校閲の鍵が1つ以上ある、または返し終えた |
 * | 3 機械に探させる | この回に検知から置いた提案がある、または返し終えた |
 * | 4 直しを提案する | この回に手で書いた提案（修正・メモ）がある、または返し終えた |
 * | 5 見直す | 返し終えた |
 * | 6 返す | 返し終えた（鍵が0・送っていない変更が0・置いた提案が1つ以上） |
 * | 7 採否を見る | 返し終えて、作者が全部決め、届いた採否をすべて知らせた・見た |
 */
export function judgeEditorProgress(facts: EditorProgressFacts): EditorProgress {
  const unsent = hasUnsent(facts.sync);
  const returned =
    facts.myLocks.length === 0 && unsent === false && facts.myProposals.length > 0;
  const round = roundProposalsOf(facts, returned);
  const decided = facts.myProposals.filter((view) => view.status !== "pending");
  const awaitingAuthor = facts.myProposals.length - decided.length;
  const unseen = decided.filter((view) => {
    const key = decisionKey(view);
    return key !== undefined && !facts.seenDecisions.has(key);
  }).length;

  const done: Record<EditorStepKey, boolean> = {
    receive: facts.sync !== undefined && facts.sync.behind === 0,
    range: returned || facts.myLocks.length > 0,
    detect: returned || round.some((view) => !isHandCategory(view.category)),
    propose: returned || round.some((view) => isHandCategory(view.category)),
    review: returned,
    return: returned,
    decisions: returned && decided.length > 0 && awaitingAuthor === 0 && unseen === 0,
  };

  const next = pickNext(facts, done, returned, unseen);
  const marks = {} as Record<EditorStepKey, EditorStepMark>;
  for (const key of EDITOR_STEP_ORDER) {
    marks[key] = done[key] ? "done" : key === next ? "next" : "todo";
  }

  const notes: Record<EditorStepKey, string> = {
    receive: noteForReceive(facts.sync),
    range: facts.myLocks.length > 0 ? `${facts.myLocks.length}話` : "",
    detect: "",
    propose: "",
    review: round.length > 0 ? `この回 ${round.length}件` : "",
    return: unsent === true && !returned ? "まだ返していません" : "",
    decisions: noteForDecisions(returned, decided.length, awaitingAuthor, unseen),
  };

  return {
    phase: returned ? "returned" : "reviewing",
    marks,
    next,
    notes,
    roundProposals: round.length,
    awaitingAuthor,
    unseenDecisions: unseen,
  };
}

/**
 * 「次はここ」。
 *
 * - **作者の新しい原稿が届いていれば、まず受け取る**（分かれたまま校閲すると、
 *   作者の版と食い違った所へ提案を置くことになる）
 * - 返し終えたあと：新しい採否が届いていれば「7」。作者の返事待ちなら印を付けない
 *   （押しても何も進まない手順を「次」と言わない）
 * - 校閲の途中：いちばん先まで済んだ手順の、次の「まだ」。**飛ばした手順で止めない**——
 *   機械に探させずに手で提案した人に「3」を指し続けると、先へ進めない
 */
function pickNext(
  facts: EditorProgressFacts,
  done: Record<EditorStepKey, boolean>,
  returned: boolean,
  unseen: number
): EditorStepKey | undefined {
  if (facts.sync && facts.sync.behind > 0) return "receive";
  if (returned) return !done.decisions && unseen > 0 ? "decisions" : undefined;
  let furthest = -1;
  // 「7. 作者の採否を見る」は返したあとの手順なので、途中の進み具合には数えない
  const flow = EDITOR_STEP_ORDER.filter((key) => key !== "decisions");
  flow.forEach((key, index) => {
    if (key !== "receive" && done[key]) furthest = index;
  });
  return flow.slice(furthest + 1).find((key) => !done[key]) ?? flow.find((key) => !done[key]);
}

function noteForReceive(sync: EditorProgressFacts["sync"]): string {
  if (!sync) return "GitHub の状態を読めていません";
  return sync.behind > 0 ? `作者の新しい原稿があります（未取得 ${sync.behind}）` : "";
}

function noteForDecisions(
  returned: boolean,
  decided: number,
  awaiting: number,
  unseen: number
): string {
  if (unseen > 0) return `新しい採否 ${unseen}件`;
  if (returned && awaiting > 0) return `作者の返事待ち ${awaiting}件`;
  return decided > 0 ? "" : "まだ届いていません";
}

/** 状態の行1つ */
export interface EditorStatusLine {
  /** 行の頭の言葉（「校閲中」など） */
  label: string;
  /** 中身 */
  value: string;
  /** 行のアイコン（codicon） */
  icon: string;
}

/** 状態の行（作品名の下に並べる）。**分からないものは「分かりません」と書く** */
export function describeEditorStatus(
  facts: EditorProgressFacts,
  progress: EditorProgress,
  rangeText: string | undefined,
  now: Date = new Date()
): EditorStatusLine[] {
  const counts = summarizeDecisions(facts.myProposals);
  const decided = counts.accepted + counts.rejected + counts.read;
  return [
    {
      label: "校閲中の話",
      icon: "lock",
      value:
        facts.myLocks.length > 0
          ? (rangeText ?? `${facts.myLocks.length}話`)
          : progress.phase === "returned"
            ? "なし（前の回は作者へ返しました）"
            : "まだ選んでいません",
    },
    {
      label: "置いた提案",
      icon: "inbox",
      value:
        progress.phase === "returned"
          ? `${facts.myProposals.length}件（作者へ返しました）`
          : progress.roundProposals > 0
            ? `この回 ${progress.roundProposals}件（まだ返していません）`
            : facts.myProposals.length > 0
              ? `この回はまだありません（これまで ${facts.myProposals.length}件）`
              : "まだありません",
    },
    {
      label: "作者の採否",
      icon: "feedback",
      value:
        decided > 0
          ? describeDecisionCounts(counts) +
            (progress.awaitingAuthor > 0 ? `（返事待ち ${progress.awaitingAuthor}）` : "") +
            (progress.unseenDecisions > 0 ? `・新しく届いた ${progress.unseenDecisions}件` : "")
          : progress.awaitingAuthor > 0 && progress.phase === "returned"
            ? `まだ届いていません（返事待ち ${progress.awaitingAuthor}）`
            : "まだ届いていません",
    },
    {
      label: "受け取り",
      icon: "cloud-download",
      value: describeReceive(facts, now),
    },
  ];
}

function describeReceive(facts: EditorProgressFacts, now: Date): string {
  const when = facts.lastReceivedAt ? formatWhen(facts.lastReceivedAt, now) : undefined;
  const head = when ? `最後に受け取ったのは ${when}` : "最後に受け取った時刻は分かりません";
  if (!facts.sync) return `${head}（GitHub の状態は読めていません）`;
  return facts.sync.behind > 0
    ? `${head}・作者の新しい原稿があります（未取得 ${facts.sync.behind}）`
    : `${head}・最新です`;
}

/** 「今日 21:40」「11月3日 9:05」。年が違えば年も書く */
export function formatWhen(iso: string, now: Date = new Date()): string | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return `今日 ${time}`;
  const date = `${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
  return at.getFullYear() === now.getFullYear() ? date : `${at.getFullYear()}年${date}`;
}

/**
 * git の HEAD の記録（`.git/logs/HEAD`）から、最後に作者の原稿を受け取った時刻を読む。
 *
 * **新しい記録を作らずに済むよう、git が書いている記録を読む。** 受け取り（`pull --ff-only`）・
 * 参加したときの取り寄せ（`clone`）・合わせ直し（`reset`）・早送り（`merge`）の行のうち最後のもの。
 * 自分の記録（`commit`）は受け取りではないので数えない。読めなければ undefined
 */
export function lastReceivedFromReflog(text: string): string | undefined {
  let last: number | undefined;
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const message = line.slice(tab + 1);
    if (!/^(pull|clone|merge|reset)\b/.test(message)) continue;
    // 「<古い> <新しい> 名前 <メール> <秒> <時差>」の秒を取る
    const head = line.slice(0, tab).trim().split(" ");
    const seconds = Number(head[head.length - 2]);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    if (last === undefined || seconds >= last) last = seconds;
  }
  return last === undefined ? undefined : new Date(last * 1000).toISOString();
}
