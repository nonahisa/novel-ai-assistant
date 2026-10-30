/**
 * 見出しの末尾の括弧書きを落とす（「本文（69行）」→「本文」、「紹介文（9行）」→「紹介文」）。
 *
 * 投稿サイトの書き出し・作品の情報の読み取り（`collectedFile.ts`・`metadataParser.ts`・
 * `workInfoParse.ts`）に同じ1行が写されていたので1つにまとめた。どこにも依存しない葉の部品。
 */
export function normalizeLabel(label: string): string {
  return label.replace(/[（(].*?[）)]\s*$/, "").trim();
}
