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
];

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
