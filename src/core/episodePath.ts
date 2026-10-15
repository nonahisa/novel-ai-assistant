import * as path from "./pathText";

/**
 * 話を book.json でどう指すか（設計書6.65.10）。
 *
 * **話数ではなく、作品フォルダからの相対パスで指す。** 話数は並べ替えや
 * 改題で動くが、パスはその話そのものを指し続ける。
 *
 * **区切りは `/` に揃える。** 手元のWindowsでは `path.relative` が `\` を
 * 返し、ブラウザ上の作品（`vscode-vfs://`）では `/` を返す。同じ作品を
 * 2つの環境で開いたときに指定が食い違わないよう、ここで揃える
 * （`models/book.ts` の読み込み側も同じ形に直している）。
 *
 * 書き出しとエディター画面の**両方がこれを通す**。片方が別の作り方を
 * すると、画面で付けた挿絵が本に出ないという分かりにくい壊れ方をする。
 *
 * **`bookStore.ts` から出した**（2026-10-16）。あちらは `vscode` を import して
 * いるので、章の束ね（`chapterGrouping.ts`）を MCP の読む口（`novel.read` の
 * 再開の1枚）から使えなかった。`bookStore.ts` は同じ名前で通している。
 * 場所の計算は `paths.ts` と同じ中身（`pathText.ts`）を使う。
 */
export function episodePathFor(workFolder: string, filePath: string): string {
  return path.relative(workFolder, filePath).replace(/\\/g, "/");
}
