/**
 * 提案パネルへ渡す「その1か所だけを指せる文脈」を作る。
 *
 * **もとは `features/checkNotation.ts` にあった。** 名前の付け替え（設計書
 * 6.37.3）も同じ文脈を要るが、あちらは `vscode` を読み込む機能層なので、
 * 純粋関数しか置かない `core` から呼べない。写しを作ると、どちらか片方だけ
 * 直したときに提案の適用が静かにずれるので、こちらへ移した。
 * `checkNotation.ts` は互換のためここを再輸出している。
 */

/**
 * その出現箇所だけを指せる前後の文脈を作る。
 *
 * 適用処理（`proposalPanel.ts`）は行の中から `original` を `indexOf` で
 * 探すため、**同じ行に同じ語が2回出ると、2件目が1件目の位置に化ける。**
 * そこで「先頭からの検索で確かにこの位置に当たる」ところまで前後を
 * 広げてから渡す。「よい。よい。」の2件目なら「。よい」まで広げれば足りる。
 */
export function buildUniqueContext(
  lineText: string,
  column: number,
  length: number
): string {
  const MAX_PAD = 16;
  for (let pad = 0; pad <= MAX_PAD; pad++) {
    const start = Math.max(0, column - pad);
    const end = Math.min(lineText.length, column + length + pad);
    const window = lineText.slice(start, end);
    if (lineText.indexOf(window) === start) return window;
    // これ以上広げられないなら打ち切る
    if (start === 0 && end === lineText.length) break;
  }
  return lineText;
}
