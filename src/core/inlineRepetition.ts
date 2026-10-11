/**
 * **1行の中で同じ短い並びが続く**応答を見つける部品（2026-10-11、残課題 A17）。
 * VS Code に依存しない。
 *
 * ## 何が起きたか
 *
 * 写真の書き起こし（P-48）で、逆さの写真を gemma4:26b に渡すと、1行の中に
 * 同じ9字を903回書き続け、出力の上限で JSON の途中で切れた。閉じていない
 * JSON は読めないので、そのページは何も残らなかった。
 *
 * `repeatedElements.ts` は**配列の要素（オブジェクト）**の繰り返ししか見ない。
 * 1つの文字列の中の繰り返しは、ここで見る。
 *
 * ## どこまでを繰り返しと見るか
 *
 * 作者の表現（「ああああ」「わんわんわん」「〓〓〓」）で止めないよう、3つの線を置く。
 *
 * - 並びは 2〜20字。1字の連続（「ああああ」「ーーー」「〓〓〓」）は数えない
 *   ——並びが1種類の字だけなら、それは1字の連続である
 * - 続けて `INLINE_REPEAT_MIN_COUNT` 回以上
 * - 繰り返しの全体が `INLINE_REPEAT_MIN_LENGTH` 字以上（「わんわん」を8回書いても
 *   32字なので止めない。903回×9字＝8,127字はどの線でも拾える）
 *
 * **写真の書き起こしにだけ使う**（指示：写真の書き起こしの受け取りで止める）。
 * ほかの機能へ掛けると、本文を引く答え（誤字脱字の `original` など）で、
 * 作中の繰り返し表現に当たって止まる恐れがある。
 */

/** 並びの長さの下限・上限（字。UTF-16 の単位で数える。日本語の字はどれも1単位） */
export const INLINE_REPEAT_MIN_UNIT = 2;
export const INLINE_REPEAT_MAX_UNIT = 20;
/** 何回続いたら止めるか */
export const INLINE_REPEAT_MIN_COUNT = 8;
/** 繰り返しの全体の長さの下限（字） */
export const INLINE_REPEAT_MIN_LENGTH = 48;

/** 見つけた繰り返し */
export interface InlineRepetition {
  /** 繰り返しの始まり（字の位置） */
  readonly start: number;
  /** 並びの長さ（字） */
  readonly unitLength: number;
  /** 見つけた時点で続いていた回数（流しの途中なら、まだ増えうる） */
  readonly count: number;
}

/** 並びが1種類の字だけか（それは1字の連続なので数えない） */
function isSingleCharUnit(text: string, start: number, length: number): boolean {
  for (let k = start + 1; k < start + length; k++) {
    if (text[k] !== text[start]) return false;
  }
  return true;
}

/** 止めるだけの長さと回数か */
function isRunaway(unitLength: number, count: number): boolean {
  return (
    count >= INLINE_REPEAT_MIN_COUNT &&
    unitLength * count >= INLINE_REPEAT_MIN_LENGTH
  );
}

/**
 * 本文の全体から、いちばん前の繰り返しを探す（受け取ったあとの後始末用）。
 *
 * 並びの長さ L ごとに「text[k] と text[k+L] が同じ」が何字続くかを数える。
 * s 字続けば、長さ s+L の区間が L 字ごとの繰り返しになっている。
 * 字数×19 回の比べで済むので、1万字の答えでも重くない。
 */
export function findInlineRepetition(text: string): InlineRepetition | undefined {
  let best: InlineRepetition | undefined;
  for (let unit = INLINE_REPEAT_MIN_UNIT; unit <= INLINE_REPEAT_MAX_UNIT; unit++) {
    let streak = 0;
    for (let k = 0; k + unit < text.length; k++) {
      if (text[k] === text[k + unit]) {
        streak += 1;
        const start = k - streak + 1;
        const count = Math.floor((streak + unit) / unit);
        if (isRunaway(unit, count) && !isSingleCharUnit(text, start, unit)) {
          // より前で見つかったものを採る。同じ始まりなら短い並びを採る（L の小さい順に回している）
          if (!best || start < best.start) best = { start, unitLength: unit, count };
          break;
        }
      } else {
        streak = 0;
      }
    }
  }
  return best;
}

/**
 * **いまの末尾**が繰り返しで終わっているか（流して受け取る途中で呼ぶ）。
 *
 * 末尾から遡って数えるだけなので、断片が届くたびに呼んでも全文を読み直さない
 * （1回あたり最大でおよそ 19 × 下限の長さの比べ）。
 */
export function endsWithInlineRepetition(text: string): InlineRepetition | undefined {
  for (let unit = INLINE_REPEAT_MIN_UNIT; unit <= INLINE_REPEAT_MAX_UNIT; unit++) {
    const need = Math.max(INLINE_REPEAT_MIN_COUNT, Math.ceil(INLINE_REPEAT_MIN_LENGTH / unit));
    const span = need * unit;
    if (text.length < span) continue;
    const from = text.length - span;
    let periodic = true;
    for (let k = text.length - 1; k - unit >= from; k--) {
      if (text[k] !== text[k - unit]) {
        periodic = false;
        break;
      }
    }
    if (!periodic || isSingleCharUnit(text, from, unit)) continue;
    return { start: from, unitLength: unit, count: need };
  }
  return undefined;
}

/**
 * 繰り返しの**1つ目の並びの終わり**で切った本文を返す。繰り返しが無ければ undefined。
 * 閉じていない JSON の後始末は呼ぶ側（`closeTruncatedJson`）が行う。
 */
export function cutAtInlineRepetition(text: string): string | undefined {
  const found = findInlineRepetition(text);
  if (!found) return undefined;
  return text.slice(0, found.start + found.unitLength);
}
