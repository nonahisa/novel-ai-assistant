/**
 * 読んだ値が、有限の数か（`NaN`・`Infinity` と、数でないものを外す）。
 *
 * `adviceProfileMirror.ts`・`manuscriptEditorStatus.ts` に同じ判定が写されていたので
 * 1つにまとめた。どこにも依存しない葉の部品。
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
