/**
 * 話数の範囲（第M話〜第N話）で絞るための部品（設計書6.38.2「第M〜N話の相関図」）。
 *
 * 作者の要望（2026-11-09「レンジスライダーで話数を絞り込めるように」）と
 * 答え（2026-11-10）：相関図・設定資料の書き出し・年表・呼び合いの一覧の
 * 4つで、第M〜N話に出てきた人物だけを残す。関係と呼称は、今までどおり
 * 第N話までに始まったものを引く。開いたときは第1話〜最終話。
 *
 * **4つの画面で同じ判断を使うためにここへ集める。** 画面ごとに「範囲に
 * 入るか」を書くと、端（M・N ちょうど）や、話数の記録が無いものの扱いが
 * 画面ごとにずれる。
 *
 * VS Code API に依存しない。
 */

/**
 * 話数の範囲。`null` は「端まで」（下端なら第1話から、上端なら最終話まで）。
 *
 * **端を選んだら数字で持たず `null` にする。** 数字のまま持つと、抽出で
 * 新しい話が増えたとき、作者が触っていないのに範囲が古い最終話で止まり、
 * 増えた人物が黙って隠れる（`normalizeUpToChapter` と同じ考え方）。
 */
export interface ChapterRange {
  from: number | null;
  to: number | null;
}

/** 絞らない範囲（第1話〜最終話） */
export const FULL_CHAPTER_RANGE: ChapterRange = Object.freeze({
  from: null,
  to: null,
});

/**
 * つまみの値を範囲へ直す。
 *
 * - **M＞N は入れ替える。** 2本のつまみは互いを追い越せるので、止めるより
 *   入れ替えたほうが、作者が置いた2つの話をそのまま使える
 * - 1〜最終話の外は端へ寄せる。端そのものは `null`（端まで）にする
 * - 話数の記録が1つも無い作品（`last <= 0`）では絞らない
 */
export function normalizeChapterRange(
  from: number | null | undefined,
  to: number | null | undefined,
  last: number
): ChapterRange {
  if (!Number.isFinite(last) || last <= 0) return { from: null, to: null };
  let low = finiteOr(from, 1);
  let high = finiteOr(to, last);
  if (low > high) [low, high] = [high, low];
  low = clamp(low, 1, last);
  high = clamp(high, 1, last);
  return {
    from: low <= 1 ? null : low,
    to: high >= last ? null : high,
  };
}

/** 絞っていない（第1話〜最終話）か */
export function isFullChapterRange(range: ChapterRange): boolean {
  return range.from === null && range.to === null;
}

/**
 * つまみに置く数字（端の `null` を、その端の話数へ）。
 * 最終話が分からない作品では両方 1 にする（つまみは押せなくする側の都合）。
 */
export function chapterRangeBounds(
  range: ChapterRange,
  last: number
): { from: number; to: number } {
  const top = Math.max(1, Number.isFinite(last) ? Math.round(last) : 1);
  return {
    from: clamp(range.from ?? 1, 1, top),
    to: clamp(range.to ?? top, 1, top),
  };
}

/**
 * その記録は第M〜N話のどこかに出てきたか。
 *
 * **話数の記録が無いもの（登場話数が空）は落とさない**——作者が手で足した
 * 人物は登場話数を持たないことがあり、消すと黙って図から消える
 * （`settingsAsOf.ts` の `hasAppearedBy` と同じ倒し方）。設定資料の
 * 書き出しはネタバレ側へ倒すので、空を落とすのは呼ぶ側で行う。
 */
export function appearedInRange(
  chapters: readonly number[],
  range: ChapterRange
): boolean {
  const known = chapters.filter((at) => Number.isFinite(at));
  if (known.length === 0) return true;
  return known.some((at) => inRange(at, range));
}

/** 第M〜N話に入る話数だけを残す（丸の大きさ＝範囲の中の登場回数） */
export function chaptersInRange(
  chapters: readonly number[],
  range: ChapterRange
): number[] {
  return chapters.filter((at) => Number.isFinite(at) && inRange(at, range));
}

/** その話数は第M〜N話に入るか（両端を含む） */
export function inRange(chapter: number, range: ChapterRange): boolean {
  if (range.from !== null && chapter < range.from) return false;
  if (range.to !== null && chapter > range.to) return false;
  return true;
}

/**
 * 話（合本なら第3〜5話のような幅）が第M〜N話と重なるか。年表の行に使う。
 *
 * **話数の読めない行（`start` が null）は残す。** プロローグや日付の記事は
 * 話数を持たず、範囲の内か外かを決められない——分からないものは落とさない
 * （この製品の流儀。設計書6.39.5）。
 */
export function spanOverlapsRange(
  start: number | null,
  end: number | null,
  range: ChapterRange
): boolean {
  if (start === null || !Number.isFinite(start)) return true;
  const last = end !== null && Number.isFinite(end) ? end : start;
  if (range.from !== null && last < range.from) return false;
  if (range.to !== null && start > range.to) return false;
  return true;
}

/** つまみの横に出す数字（「第3話〜第8話」）。1話だけなら「第3話」 */
export function chapterRangeText(from: number, to: number): string {
  return from === to ? `第${from}話` : `第${from}話〜第${to}話`;
}

/**
 * 入力欄に打った範囲を読む（設定資料の書き出し）。
 *
 * 「3〜8」「3-8」「3~8」「３－８」などを受ける。数字1つだけなら
 * 「第1話〜その話」（今までの「第N話まで」と同じ意味）。読めなければ
 * `undefined`。M＞N の入れ替えは `normalizeChapterRange` に任せず
 * ここでも行う——入力欄では最終話が分からないことがある。
 */
export function parseChapterRangeInput(
  text: string
): { from: number; to: number } | undefined {
  const normalized = toHalfWidthDigits(text).trim();
  if (normalized === "") return undefined;
  const parts = normalized.split(/\s*[-~〜～－ー―‐]\s*/u);
  if (parts.length > 2) return undefined;
  const numbers = parts.map((part) => Number(part));
  if (
    numbers.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    parts.some((part) => !/^\d+$/u.test(part))
  ) {
    return undefined;
  }
  if (numbers.length === 1) return { from: 1, to: numbers[0] };
  const [a, b] = numbers;
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９]/gu, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0)
  );
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return value === null || value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.round(value);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
