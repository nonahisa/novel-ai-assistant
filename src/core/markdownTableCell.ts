/**
 * 表の升目に入れる形へ直す。
 *
 * 縦棒がそのまま入ると、そこで列が増えて表が崩れる。中身は消さずに逃がす。
 * 改行は扱わない（改行も逃がす別の形は `tuningStats.ts`・`diagnoseWeb.ts` の `escapeCell`）。
 *
 * `finishReportDoc.ts`・`checkOpening.ts` に同じ関数が `cell` の名前で写されていたので
 * 1つにまとめた。どこにも依存しない葉の部品。
 */
export function markdownTableCell(text: string): string {
  return text.split("|").join("\\|");
}
