/**
 * 外から呼ぶ束（MCP サーバー）が名乗る版（設計書6.87.8 の1）。
 *
 * **`package.json` をここで読まない。** 束は1ファイルにまとめて
 * `dist/mcp-server.mjs` へ置くので、走らせるときに読める場所に
 * `package.json` があるとは限らない（配布物にも入れない）。
 *
 * **書き写しだが、ずれたら止まる。** `test/unit/mcpVersion.test.ts` が
 * `package.json` と突き合わせる——CHANGELOG や README の版を
 * `showVersion.test.ts` が見張っているのと同じ形である。
 * こうしてあるのは、**テストを `npm run build` に依存させない**ため
 * （ビルドの `define` で埋めると、束を作るまで確かめられない）。
 *
 * 版を上げるときは、CLAUDE.md の「版は5つの文書で揃える」の表に加えて
 * **ここも直す**（忘れても `npm run check` が落ちる）。
 */
export const SERVER_VERSION = "0.50.1";

/** MCP のクライアントに見せる名前。`.mcp.json` の登録名と揃える */
export const SERVER_NAME = "novel-ai-assistant";
