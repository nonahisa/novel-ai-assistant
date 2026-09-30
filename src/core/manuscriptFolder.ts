import { fileReader, isNotFound, type FileReader } from "./fileRead";
import {
  resolveManuscriptDirAsync,
  type ManuscriptPaths,
} from "./manuscriptFolderRule";

/**
 * 本文として歩くフォルダーを、拡張機能の読み口で決める。
 *
 * **決め方は `manuscriptFolderRule.ts` にある**（MCP も同じものを通す）。
 * ここは読み口（`fileRead.ts`。手元は Node の `fs`、ブラウザ版は
 * `vscode.workspace.fs`）をつなぐだけ。`vscode` に触れる部分を分けたのは、
 * 決め方を MCP の束へ持ち込めるようにするため。
 *
 * 走査・新しい話の置き先（「話を追加」「書き始める」）・Word の取り込み・
 * Markdown への変換は、すべてここを通す。**写しを作らない。**
 *
 * @param reader 読み口。省けば `fileReader()`（走査は用意済みのものを渡す）
 */
export async function resolveManuscriptDir(
  p: ManuscriptPaths,
  reader?: FileReader
): Promise<string> {
  const r = reader ?? (await fileReader());
  return resolveManuscriptDirAsync(p, {
    async kind(location) {
      try {
        return (await r.stat(location)).type;
      } catch (error) {
        // **「見つからない」以外の失敗は投げる**（前の `pathExists` と同じ）。
        // 読めない事情を握りつぶして直下へ切り替えない
        if (isNotFound(error)) return "missing";
        throw error;
      }
    },
    async list(location) {
      try {
        return await r.readDirectory(location);
      } catch {
        // 読めないフォルダーは一括読みでも飛ばされる。同じく「無い」とみなす
        return undefined;
      }
    },
  });
}
