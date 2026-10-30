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

/**
 * `relativeTo` と同じだが、根を絶対の道に直さない形（根がすでに絶対の道で渡る所用）。
 *
 * `extractCommit`・`synopsisCommit` に同じ関数が `relativeTo` の名前で写されていた。
 * 根を直す段の有無で、相対の道の結果が変わりうるので、`relativeTo` とは混ぜない。
 */
export function relativeToRoot(root: string, target: string): string {
  return nodePath.relative(root, target).split(nodePath.sep).join("/");
}
