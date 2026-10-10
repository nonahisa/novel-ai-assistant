import type { Character } from "../models/character";
import {
  applyNarratorMoves,
  describeNarratorMove,
  narratorMoveKey,
  type MoveDestinationOption,
  type NarratorMoveItem,
  type NarratorMoveKind,
} from "./narratorMoves";

/**
 * 語り手の取り違えで主人公に入った値を「別の人物へ移す案」を、提案パネルの
 * 「設定資料の更新」に承認待ちとして並べるための形（作者の裁定 2026-10-10
 * 「提案パネルにも出す」。設計書6.5.12）。
 *
 * ## なぜ人物の承認待ち（`pending-characters/`）と別の置き場にしたか
 *
 * 人物の承認待ちは「1ファイル＝1人物の書き換え後の姿」で、読む側が7か所ある
 * （抽出・相談・話数の付け替え・プロットの名前・分けた記録の取り下げ・MCP の
 * `pending.list`／`settings.propose`／`novel.extract.commit`）。移す案を同じ
 * 置き場へ混ぜると、どれか1つでも「主人公の更新案」と読み違えた日に、
 * **積んだ時点の主人公の写しで資料が巻き戻る**（`applyPendingCharacterUpdates`
 * は差分の無い案を古い案として消しもする）。移す案は「どの値を、主人公から
 * どの人物へ」だけを持ち、書き換え後の姿は**反映のときに、いまの資料から**
 * 組む（`applyNarratorMoves`）。積んでから承認までに作者が資料を直していても、
 * 見つからない値は動かさない。
 *
 * **1ファイル＝移す案1件**（提案パネルの1行）。1行ごとに移し先を選ぶので、
 * 項目をまとめると選びようがなくなる。
 *
 * `vscode` に依存しない（読み書きは `pendingNarratorMoveStore.ts`）。
 */

/** 置き場（`.aiwriter/` の下） */
export const PENDING_MOVES_DIR = "pending-moves";

/** 見送った案の鍵の置き場（`.aiwriter/cache/` の下。誤字脱字の「無視」と同じ作り） */
export const NARRATOR_MOVE_DISMISSED_FILE = "narrator_move_dismissed.json";

/** 見送りを覚えておく件数。際限なく育てない（`TypoDismissedHistory` と同じ考え） */
export const MAX_NARRATOR_MOVE_DISMISSED = 500;

/** 承認待ちのファイルの中身 */
export interface PendingNarratorMovePayload {
  kind: "narratorMove";
  /** 鍵（`narratorMoveKey`）。重複と見送りの照合に使う */
  key: string;
  /** 値を外す人物（主人公）の id と、積んだときの名前（名前は表示の控え） */
  sourceId: string;
  sourceName: string;
  item: NarratorMoveItem;
  stagedAt: string;
}

/** 読んだ承認待ち1件 */
export interface PendingNarratorMove extends PendingNarratorMovePayload {
  filePath: string;
}

/** ファイル名。鍵で付けるので、同じ案は同じ名前になる（二重に積めない） */
export function pendingNarratorMoveFileName(sourceId: string, key: string): string {
  return `${sourceId}_${key}.json`;
}

export function buildPendingNarratorMovePayload(
  source: Pick<Character, "id" | "name">,
  item: NarratorMoveItem,
  stagedAt: string
): PendingNarratorMovePayload {
  return {
    kind: "narratorMove",
    key: narratorMoveKey(source.id, item),
    sourceId: source.id,
    sourceName: source.name,
    item,
    stagedAt,
  };
}

const MOVE_KINDS: readonly NarratorMoveKind[] = [
  "change",
  "personalityFacet",
  "speechStyleFacet",
  "relation",
  "address",
  "firstPersonVariant",
  "appearedChapters",
];

/**
 * 承認待ちのファイルを読む。**壊れていたら例外を投げ、直さない**（実装ルール2）。
 * 鍵はファイルに書いたものを信じず、中身から組み直す（手で書き換えられた
 * ファイルが別の案の鍵を名乗っても、見送りの記録を取り違えない）。
 */
export function readPendingNarratorMoveFile(
  parsed: unknown,
  filePath: string
): PendingNarratorMove {
  if (!isObject(parsed) || parsed.kind !== "narratorMove") {
    throw new Error("移す案の形ではありません（kind が narratorMove でない）");
  }
  const { sourceId, sourceName, item, stagedAt } = parsed;
  if (typeof sourceId !== "string" || !sourceId) {
    throw new Error("移す案に sourceId がありません");
  }
  if (!isObject(item)) throw new Error("移す案に item がありません");
  if (!MOVE_KINDS.includes(item.kind as NarratorMoveKind)) {
    throw new Error(`移す案の種類が分かりません（${String(item.kind)}）`);
  }
  if (typeof item.label !== "string" || typeof item.value !== "string") {
    throw new Error("移す案の項目名か値がありません");
  }
  if (!Array.isArray(item.chapters) || !item.chapters.every(Number.isSafeInteger)) {
    throw new Error("移す案の話数が読めません");
  }
  if (!isObject(item.destination) || !Array.isArray(item.destination.candidates)) {
    throw new Error("移す案の移し先が読めません");
  }
  const move = item as unknown as NarratorMoveItem;
  return {
    kind: "narratorMove",
    key: narratorMoveKey(sourceId, move),
    sourceId,
    sourceName: typeof sourceName === "string" ? sourceName : sourceId,
    item: move,
    stagedAt: typeof stagedAt === "string" ? stagedAt : "",
    filePath,
  };
}

/**
 * 抽出の終わりに積む案を決める（作者の裁定 2026-10-10）。
 *
 * - 承認待ちに同じ鍵がある案は積まない（毎回積み直さない）
 * - 見送った鍵の案は積まない（作者が「このままでよい」と決めた）
 * - 同じ実行の中でも同じ鍵は1度だけ
 */
export function planNarratorMoveStaging(
  found: ReadonlyArray<{ source: Pick<Character, "id" | "name">; items: readonly NarratorMoveItem[] }>,
  options: {
    pendingKeys: ReadonlySet<string>;
    dismissedKeys: ReadonlySet<string>;
    now: string;
  }
): PendingNarratorMovePayload[] {
  const seen = new Set<string>();
  const staged: PendingNarratorMovePayload[] = [];
  for (const { source, items } of found) {
    for (const item of items) {
      const payload = buildPendingNarratorMovePayload(source, item, options.now);
      if (options.pendingKeys.has(payload.key)) continue;
      if (options.dismissedKeys.has(payload.key)) continue;
      if (seen.has(payload.key)) continue;
      seen.add(payload.key);
      staged.push(payload);
    }
  }
  return staged;
}

/** 提案パネルに並べられる移す案1件 */
export interface NarratorMoveReviewItem {
  move: PendingNarratorMove;
  /** いまの台帳の主人公 */
  source: Character;
  /** 移し先の候補（いまの台帳に居る人だけ。名前はいまの名前） */
  options: MoveDestinationOption[];
  /** 既定の移し先。名指しできた案だけ（選ぶ案は null＝既定では選ばない） */
  defaultId: string | null;
}

export type NarratorMoveStaleReason = "missing" | "noChange";

/**
 * 承認待ちを、並べられるものと片付けてよいものへ分ける。
 *
 * - 主人公が台帳に居ない（まとめた・消した）→ `missing`
 * - 値がいまの主人公の資料に無い（作者が直した・別の承認で外れた）→ `noChange`
 *
 * **ここは読むだけ**（片付けは呼ぶ側が決める。開いただけで消さない）。
 */
export function assembleNarratorMoveReview(
  moves: readonly PendingNarratorMove[],
  characters: readonly Character[]
): {
  items: NarratorMoveReviewItem[];
  stale: Array<{ move: PendingNarratorMove; reason: NarratorMoveStaleReason }>;
} {
  const items: NarratorMoveReviewItem[] = [];
  const stale: Array<{ move: PendingNarratorMove; reason: NarratorMoveStaleReason }> = [];
  const byId = new Map(characters.map((person) => [person.id, person]));
  for (const move of moves) {
    const source = byId.get(move.sourceId);
    if (!source) {
      stale.push({ move, reason: "missing" });
      continue;
    }
    // 外すだけで試し、いまの資料に値があるかを確かめる（書き込まない）
    const trial = applyNarratorMoves(
      source,
      characters,
      [{ item: move.item, destinationId: null }],
      new Date(0).toISOString()
    );
    if (trial.missing > 0) {
      stale.push({ move, reason: "noChange" });
      continue;
    }
    const options: MoveDestinationOption[] = [];
    for (const candidate of move.item.destination.candidates) {
      const person = byId.get(candidate.id);
      if (!person || person.id === source.id) continue;
      if (options.some((entry) => entry.id === person.id)) continue;
      options.push({ id: person.id, name: person.name });
    }
    const named = move.item.destination;
    const defaultId =
      named.kind === "named" && options.some((entry) => entry.id === named.id)
        ? named.id
        : null;
    items.push({ move, source, options, defaultId });
  }
  return { items, stale };
}

/**
 * 移し先の選びを、提案パネルから届く鍵の並びで運ぶ印（0.102.3）。
 *
 * パネルの「反映する」「まとめて適用」は、レコードごとの鍵の並び（✕ の印。
 * `dropKeys`）をすでに運んでいる。移し先のためだけに別の通り道を足すと、
 * 1件ずつ・まとめて・外部AIのまとめての3つの道へ同じ引数を通すことになり、
 * どれか1つで落ちたとき「選んだのに外すだけになった」が起きる。印の頭で
 * 見分け、ここでだけ読み取る。
 */
export const MOVE_DESTINATION_KEY_PREFIX = "moveTo:";
/** 「外すだけ」を選んだ印の値 */
export const MOVE_REMOVE_ONLY = "-";

/**
 * 届いた鍵から移し先を読む。
 *
 * - 選んだ人の id → その人
 * - 「外すだけ」→ null
 * - 何も選んでいない → 既定（名指しできた案だけ）。既定も無ければ例外
 *   ——**選ばないまま反映しない**（作者の裁定。既定では選ばない）
 * - 候補に無い id → 例外（画面の外から来た値で、知らない人を書き換えない）
 */
export function destinationFromKeys(
  keys: readonly string[] | undefined,
  item: Pick<NarratorMoveReviewItem, "options" | "defaultId">
): string | null {
  const chosen = [...(keys ?? [])]
    .reverse()
    .find((key) => key.startsWith(MOVE_DESTINATION_KEY_PREFIX));
  if (chosen === undefined) {
    if (item.defaultId) return item.defaultId;
    throw new Error("移し先を選んでください（「外すだけ」も選べます）。");
  }
  const value = chosen.slice(MOVE_DESTINATION_KEY_PREFIX.length);
  if (value === MOVE_REMOVE_ONLY) return null;
  if (!item.options.some((option) => option.id === value)) {
    throw new Error("選んだ移し先が候補にありません。提案パネルを開き直してください。");
  }
  return value;
}

/** 提案パネルの行に出す説明（設定資料パネル・MCP と同じ文を通す） */
export function describeNarratorMoveReviewItem(item: NarratorMoveReviewItem): {
  /** 行の出どころの欄（「移す案：役割「皇子」（第12話）」） */
  source: string;
  /** 行の本文（いまの値・なぜ疑ったか） */
  changes: string[];
} {
  const text = describeNarratorMove(item.move.item);
  return {
    source: text.label,
    changes: [`いまの値：${text.before}`, text.reason],
  };
}

/** ログに書く値の言い方（「役割「皇子」（第12話）」。登場話は話数だけ） */
export function narratorMoveValueForLog(item: NarratorMoveItem): string {
  const chapters = item.chapters.map((chapter) => `第${chapter}話`).join("・");
  return item.kind === "appearedChapters"
    ? `${item.label}（${chapters}）`
    : `${item.label}「${item.value}」（${chapters}）`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
