import * as nodePath from "node:path";

/**
 * 作品フォルダーからの相対。区切りは読みやすいほうへ揃える（`/`）。
 *
 * MCP の道具5つ（`extractEnrichStash`・`extractStash`・`propose`・`proposeRecord`・
 * `synopsisStash`）に同じ関数が写されていたので1つにまとめた。
 *
 * **node の path を使うので、MCP サーバーの中だけで読む。** MCP サーバーは別の
 * node のプロセスで動き、拡張機能（ブラウザ版を含む）の束には入らない。
 */
export function relativeTo(folder: string, target: string): string {
  return nodePath
    .relative(nodePath.resolve(folder), target)
    .split(nodePath.sep)
    .join("/");
}
