/**
 * 読み書き役と画面を、Node だけで動く1つの束（desk/dist/desk.mjs）にまとめる。
 *
 * - `vscode` は desk/vscodeShim.mjs に差し替える（書き戻しは拡張機能と同じ
 *   src/core/textFile.ts を通すため。写しを作らない）
 * - 依存（iconv-lite・diff など）も束の中へ入れる。`npm ci` をしていない機械でも
 *   `node desk/dist/desk.mjs` だけで起動できるようにする
 * - 画面（原稿エディターの HTML とスクリプト）も束の中の関数が組み立てるので、
 *   ほかの資材を読みに行かない
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
export const DESK_BUNDLE = nodePath.join(here, "dist", "desk.mjs");

export async function buildDesk() {
  await esbuild.build({
    absWorkingDir: nodePath.resolve(here, ".."),
    entryPoints: [nodePath.join(here, "main.mjs")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: DESK_BUNDLE,
    alias: { vscode: nodePath.join(here, "vscodeShim.mjs") },
    // 束の中の CommonJS（iconv-lite など）が Node の組み込みを require するため
    banner: {
      js: 'import { createRequire as __deskCreateRequire } from "node:module"; const require = __deskCreateRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  return DESK_BUNDLE;
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDesk();
  console.log("[desk] 束を作りました:", DESK_BUNDLE);
}
