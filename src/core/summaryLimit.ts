/**
 * 一覧に出す短い紹介の長さを、コード側で確かめる。
 *
 * プロンプトで「50字以内」と指示しても、モデルは平気で超えてくる。
 * 文字数の制限は必ずコード側で再検証する、というのがこの作品の約束。
 *
 * 超えていたら捨てずに切り詰める。せっかく書かれた紹介を丸ごと落とすより、
 * 途中まででも一覧に出したほうが作者の役に立つ。
 */

/** 一覧に出す紹介の上限 */
export const SUMMARY_MAX_CHARS = 50;

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
