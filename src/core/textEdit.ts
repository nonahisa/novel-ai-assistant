/**
 * 書き換わった範囲だけを取り出す（設計書6.25）。
 *
 * 原稿エディタは、画面で打たれた本文を VS Code の文書へ返す。そのとき
 * **文書をまるごと差し替えると、次の3つが壊れる。**
 *
 * 1. **元に戻す（Ctrl+Z）が使えなくなる。** 1文字打つたびに「全文を
 *    書き換えた」1手になるので、戻すと本文がごっそり入れ替わる
 * 2. **カーソルと選択が飛ぶ。** 全文が変わったと見なされるため
 * 3. **重い。** 4万字の本文で毎打鍵ごとに全文を送り直すことになる
 *
 * そこで**前と後ろの一致する部分を除いて、変わった1か所だけ**を返す。
 * 日本語の入力は語の途中に差し込む形が多く、この見方でほぼ1か所に収まる。
 */

export interface MinimalEdit {
  /** 置き換える範囲の始まり（UTF-16のindex） */
  start: number;
  /** 置き換える範囲の終わり */
  end: number;
  /** そこへ入れる文字列 */
  insert: string;
}

/**
 * サロゲートペアの途中で切らないよう、境界を1つ手前へ戻す。
 *
 * **絵文字や一部の漢字は2つの単位で1文字**である。途中で切ると、
 * 壊れた片割れが本文へ入る。
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 変わった1か所を返す。変わっていなければ `undefined`。
 */
export function computeMinimalEdit(
  before: string,
  after: string
): MinimalEdit | undefined {
  if (before === after) return undefined;

  // 前から一致する長さ
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;
  // ペアの途中で切らない
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--;

  // 後ろから一致する長さ（前と重ならないところまで）
  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) {
    suffix--;
  }

  return {
    start: prefix,
    end: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}
