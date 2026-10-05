import type { RetrievalItem } from "./retrievalCorpus";
import { passageHash, splitPassages } from "./passages";

/**
 * 1話の本文を、検索の場面へ分ける。
 *
 * 場面が2つ以上になったときだけ、何番目か（`part`）を持たせる。
 * 画面を開かずに確かめられるよう、ファイルを読む所から分けてある。
 *
 * **VS Code に依存しない所へ出した**（0.99.19）。元は `retrievalCorpus.ts`
 * にあったが、あちらは設定資料の台帳を読むために VS Code API を引き込む。
 * MCP の `novel.search` が**製品と同じ id・同じ鍵（`passageHash`）**で場面を
 * 組まないと、索引のベクトルを1件も引けないので、ここ1か所から両方が使う。
 */
export function manuscriptItems(
  label: string,
  text: string,
  origin?: { filePath?: string; chapter?: number | null }
): RetrievalItem[] {
  const passages = splitPassages(text);
  return passages.map((passage, index) => ({
    // 形は `retrievalCorpus.ts` の `makeItem`（本文は作者の記述として数えない）
    id: `本文:${label}#${index}`,
    source: "本文" as const,
    label,
    text: passage,
    hash: passageHash(passage),
    authorWritten: false,
    ...(passages.length > 1
      ? { part: { index: index + 1, total: passages.length } }
      : {}),
    ...(origin?.filePath !== undefined ? { filePath: origin.filePath } : {}),
    ...(origin && "chapter" in origin ? { chapter: origin.chapter ?? null } : {}),
  }));
}
