/**
 * 「読み間違いの見込み」の行の分類名（設計書6.42.5）。校正・メモパネルの札と絞り込み、
 * 提案パネルのタブの名前になる。
 *
 * **ファイルを分けてあるのは、読み込みの輪を作らないため。** 記録の表（`findingSource.ts`）と
 * 色の表（`sceneMemoRows.ts`）がこの名前を引き、行を組む側（`readingMisread.ts`）は
 * `findingSource.ts` を引く。名前を `readingMisread.ts` に置くと、表が組まれる前に名前を読む
 */
export const MISREAD_FINDING_LABEL = "読み間違いの見込み";

/** 「読み間違いの見込み」の行か */
export function isMisreadFinding(finding: { label: string }): boolean {
  return finding.label === MISREAD_FINDING_LABEL;
}
