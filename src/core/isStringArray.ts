/**
 * 読んだ JSON の欄が、文字列だけの並びか。
 *
 * core の3か所に同じ判定が写されていたので1つにまとめた。どこにも依存しない葉の部品。
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
