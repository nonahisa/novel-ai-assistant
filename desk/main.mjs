/**
 * 束の入口（desk/dist/desk.mjs になる）。
 *
 * 作品フォルダーとポートは**起動の引数か環境変数**で受ける
 * （`--work <フォルダー> --port <番号>`、または NOVELAI_DESK_WORK・NOVELAI_DESK_PORT）。
 * 場所をソースへ埋め込まない——このあとプラグインや拡張機能から配るとき、
 * 誰の機械でも同じ束がそのまま動くようにするため。
 */
import { startDeskServer } from "./server.mjs";

const argv = process.argv.slice(2);
if (!argv.includes("--work") && process.env.NOVELAI_DESK_WORK) {
  argv.push("--work", process.env.NOVELAI_DESK_WORK);
}
if (!argv.includes("--port") && process.env.NOVELAI_DESK_PORT) {
  argv.push("--port", process.env.NOVELAI_DESK_PORT);
}

startDeskServer(argv).catch((error) => {
  console.error("[desk] 起動できませんでした:", error instanceof Error ? error.message : error);
  process.exit(1);
});
