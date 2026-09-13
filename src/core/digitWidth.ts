/**
 * 半角と全角の数字の行き来（表記ゆれ検知の `digit_width` の組が使う）。
 *
 * **`episodeParser.toHalfWidthDigits` とは別に置く。** あちらは
 * ファイル名の話数を読むための「文字列まるごとの変換」で、
 * こちらは本文の**1文字を、その場所だけ**置き換えるためのものである。
 * 混ぜると、話数の読み取りが本文の都合で動くことになる。
 *
 * VS Code APIに依存しない。
 */

/** 全角の数字。半角の `0`〜`9` と同じ並びで持つ */
export const FULLWIDTH_DIGITS = "０１２３４５６７８９";

/** 半角と全角の符号位置の差（`0` と `０`） */
const WIDTH_GAP = 0xfee0;

export function isHalfWidthDigit(char: string): boolean {
  return char.length === 1 && char >= "0" && char <= "9";
}

export function isFullWidthDigit(char: string): boolean {
  return char.length === 1 && char >= "０" && char <= "９";
}

/** 半角の数字1文字を全角へ。数字でなければそのまま返す */
export function toFullWidthDigit(char: string): string {
  if (!isHalfWidthDigit(char)) return char;
  return String.fromCharCode(char.charCodeAt(0) + WIDTH_GAP);
}

/** 全角の数字1文字を半角へ。数字でなければそのまま返す */
export function toHalfWidthDigit(char: string): string {
  if (!isFullWidthDigit(char)) return char;
  return String.fromCharCode(char.charCodeAt(0) - WIDTH_GAP);
}

/**
 * 「どちらの幅へ揃えるか」の印（`features/checkNotation.ts`）。
 *
 * 揃える先は**文字列1つ**で受け渡す作りだが、数字の組だけは
 * 0〜9を1組にまとめてあるので、**出現ごとに置換先が違う**（3→３、5→５）。
 * 揃える先の表記そのものを渡せないため、幅を表す印を代わりに渡す。
 *
 * **本文の表記とは衝突しない。** ほかの組が渡すのは本文に実在する表記で
 * あり、数字の組の form は数字1文字だけである。`__` で始まる ASCII の
 * この綴りが、どちらかに一致することはない。
 */
export const DIGIT_WIDTH_FULL = "__digit_full";
export const DIGIT_WIDTH_HALF = "__digit_half";

export type DigitWidthTarget =
  | typeof DIGIT_WIDTH_FULL
  | typeof DIGIT_WIDTH_HALF;

export function isDigitWidthTarget(value: string): value is DigitWidthTarget {
  return value === DIGIT_WIDTH_FULL || value === DIGIT_WIDTH_HALF;
}

/**
 * その表記を、選んだ幅へ直した形。
 *
 * **既にその幅なら `undefined`**（直すものが無い）。「全角に揃える」を
 * 選んだときに、元から全角で書いてある箇所まで指摘しないためにある。
 */
export function digitWidthReplacement(
  surface: string,
  target: DigitWidthTarget
): string | undefined {
  if (target === DIGIT_WIDTH_FULL) {
    return isHalfWidthDigit(surface) ? toFullWidthDigit(surface) : undefined;
  }
  return isFullWidthDigit(surface) ? toHalfWidthDigit(surface) : undefined;
}
