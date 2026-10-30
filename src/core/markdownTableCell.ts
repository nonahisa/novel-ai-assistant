/**
 * 表の升目に入れる形へ直す。
 *
 * 縦棒がそのまま入ると、そこで列が増えて表が崩れる。中身は消さずに逃がす。
 * 改行は扱わない（改行も1行にそろえる形は下の `markdownTableCellOneLine`）。
 *
 * `finishReportDoc.ts`・`checkOpening.ts` に同じ関数が `cell` の名前で写されていたので
 * 1つにまとめた。どこにも依存しない葉の部品。
 */
export function markdownTableCell(text: string): string {
  return text.split("|").join("\\|");
}

/**
 * 表の中で改行や縦棒が崩れないようにする（縦棒は逃がし、改行は空白にして1行にそろえる）。
 *
 * `tuningStats.ts`・`diagnoseWeb.ts` に同じ関数が `escapeCell` の名前で写されていたので
 * 1つにまとめた。
 */
export function markdownTableCellOneLine(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
