/**
 * 並べ替え用の最初の話数。話数が無いものは、気づく前からあった値なので先に置く（-1）。
 *
 * `recordChanges.ts`・`settingsMarkdown.ts` に同じ関数が写されていたので1つにまとめた。
 * どこにも依存しない葉の部品。
 */
export function firstChapter(chapters: number[]): number {
  return chapters.length > 0 ? Math.min(...chapters) : -1;
}
