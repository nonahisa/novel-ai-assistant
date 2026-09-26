/**
 * 開発中の起動口（.claude/launch.json から呼ぶ）。
 *
 * **起こすたびに束を作り直す。** 古い束を使い回すと「直したはずの不具合が
 * 再現する」（設計書6.87.6 の4、MCPの束で踏んだ）。esbuild が無い機械
 * （配られた束だけがある所）では、作り直さずに今ある束で起こす。
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import * as nodePath from "node:path";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
let bundle = nodePath.join(here, "dist", "desk.mjs");
try {
  const { buildDesk } = await import("./build.mjs");
  bundle = await buildDesk();
} catch (error) {
  console.warn(
    "[desk] 束を作り直せませんでした。今ある束で起こします:",
    error instanceof Error ? error.message : error
  );
}
await import(pathToFileURL(bundle).href);
