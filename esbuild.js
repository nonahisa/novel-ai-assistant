const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * 手元向け（Node）とブラウザ向け（vscode.dev / github.dev）の、2つの束を作る。
 *
 * **同じ `src/extension.ts` から2つビルドする。** ソースを分けない
 * （設計書5.8）。ブラウザ側だけ、Node組み込みモジュールを差し替える
 * （`path` → `path-browserify`）／実行時まで解決を遅らせる（`external`）。
 *
 * Node専用の機能（git・Ollama・パッケージ導入）は、`extension.ts` 側で
 * 動的import＋`canRunProcesses()` の判定により、ブラウザでは読み込まれない
 * ようにしてある（設計書5.8.5）。ここでの `external` 指定は、
 * その動的importの解決を「読み込まれたら失敗する」ではなく
 * 「実行時まで待つ」に変えるためのもの。
 */
const BROWSER_EXTERNAL_BUILTINS = [
  "os",
  "node:os",
  "node:fs/promises",
  "node:fs",
  "node:path",
  "node:child_process",
  "child_process",
  /*
    **`undici` はNodeにしか無い**（設計書6.63）。

    `ai/fetchTimeouts.ts` が `canRunProcesses()` で確かめてから動的に
    読み込むが、**esbuild は動的 import も束ねようとする**ので、ここで
    外さないとブラウザ版のビルドが `node:stream` を解決できずに落ちる
    （実際に落ちた。CLAUDE.md 規則7）。

    外に出せば、ブラウザでは読み込みが実行時に失敗し、
    `fetchTimeouts.ts` の try/catch が受けて「渡さない」に倒れる。
    ブラウザの `fetch` にはそもそもこの待ち時間の制限が無いので実害は無い。
  */
  "undici",
];

/**
 * 開発用の道具（実機確認を回すヘルパー）を束に入れるか。
 *
 * **配布物には入れない**（作者の指定、2026-08-26）。`false` に畳むと、
 * `if (__DEV_HELPERS__)` の中は死んだ枝になり、esbuild がまるごと落とす。
 * 中にある動的importも消えるので、**そのファイル自体が束に入らない。**
 *
 * 入っていないことは `npm run verify:vsix` が見張る。
 */
const DEFINE = { __DEV_HELPERS__: production ? "false" : "true" };

async function main() {
  const desktop = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    define: DEFINE,
    logLevel: "info",
  });

  const browser = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    outfile: "dist/browser-extension.js",
    external: ["vscode", ...BROWSER_EXTERNAL_BUILTINS],
    define: DEFINE,
    alias: { path: "path-browserify" },
    logLevel: "info",
  });

  if (watch) {
    await Promise.all([desktop.watch(), browser.watch()]);
  } else {
    await Promise.all([desktop.rebuild(), browser.rebuild()]);
    await Promise.all([desktop.dispose(), browser.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
