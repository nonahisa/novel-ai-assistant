/**
 * 一覧に出す短い紹介の長さを、コード側で確かめる。
 *
 * プロンプトで字数を指示しても、モデルは平気で超えてくる。
 * 文字数の制限は必ずコード側で再検証する、というのがこの作品の約束。
 *
 * 超えていたら捨てずに切り詰める。せっかく書かれた紹介を丸ごと落とすより、
 * 途中まででも一覧に出したほうが作者の役に立つ。
 */

/**
 * 一覧に出す紹介の上限。
 *
 * 50字で始めたが、実データで「主人公。転生した超絶美少女で、霊的なものが
 * 見えるようになった。」のような、あと一息で言い切れる紹介が切れていたため
 * 60字にした。上限を変えるときは、プロンプト側の指示も必ず合わせること。
 */
export const SUMMARY_MAX_CHARS = 60;

export function clampSummary(
  value: string | null | undefined,
  maxChars = SUMMARY_MAX_CHARS
): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;

  const characters = [...text];
  if (characters.length <= maxChars) return text;

  // 途中でぶつ切りにすると読みにくいので、句読点の切れ目まで戻す。
  // 戻しすぎると情報が減るため、上限の6割より前には戻さない
  const head = characters.slice(0, maxChars).join("");
  const floor = Math.floor(maxChars * 0.6);
  for (const mark of ["。", "、", "．", "，"]) {
    const at = head.lastIndexOf(mark);
    if (at >= floor) return head.slice(0, at + 1);
  }
  return head;
}
