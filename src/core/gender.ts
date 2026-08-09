/**
 * 性別の表記を揃える。
 *
 * AIは「男」「少年」「オス」などと本文の言い方をそのまま返してくる。
 * プロンプトで「男性」「女性」に揃えるよう指示してあるが、
 * 指示どおりに書かないことがあるので、コード側でも揃える。
 *
 * ただし**知っている言い方だけを置き換える**。
 * 「〜らしい」「男装の女性」のような文を部分一致で書き換えると、
 * 意味が反転する。当てはまらないものは作者の（または本文の）
 * 言い方をそのまま残す。
 */

const MALE_FORMS = new Set([
  "男性", "男", "男の子", "男子", "男児", "少年", "オス", "雄", "♂",
  "male", "Male", "MALE", "M",
]);

const FEMALE_FORMS = new Set([
  "女性", "女", "女の子", "女子", "女児", "少女", "メス", "雌", "♀",
  "female", "Female", "FEMALE", "F",
]);

export function normalizeGender(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (!text) return null;
  if (MALE_FORMS.has(text)) return "男性";
  if (FEMALE_FORMS.has(text)) return "女性";
  return text;
}

/** 画面で選ばせる候補。作者は自由に入力もできる */
export const GENDER_SUGGESTIONS = ["男性", "女性", "不明"] as const;
