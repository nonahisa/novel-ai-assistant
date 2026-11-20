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
  /*
    手元のAIの順番待ち（設計書6.76.1）が「一括処理の中か」を運ぶのに使う
    （`core/localAiLeaseNode.ts`）。門が `canRunProcesses()` で確かめてから
    動的に読むので、ブラウザでは読み込まれない
  */
  "node:async_hooks",
  /*
    人物の声の送り先の端末名を引く（設計書6.42.3。`core/voiceHostName.ts`）。
    ブラウザ版では引かない（`isWebRuntime()` で先に返す）ので、読み込まれない
  */
  "node:dns",
  /*
    Google のログインの戻りを手元の 127.0.0.1 で待ち受ける（設計書5.10.9。
    `features/googleDriveAuth.ts`）。ブラウザ版では命令を隠し、呼ばれても
    `canRunProcesses()` で先に返すので、読み込まれない
  */
  "node:http",
  /*
    六徳 IME の確定の知らせを名前付きパイプで受ける（設計書6.13.8。
    `core/imeLinkPipeNode.ts`）。`features/imeCommitLink.ts` が Windows の手元の
    VS Code だと確かめてから動的に読むので、ブラウザでは読み込まれない
  */
  "node:net",
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

// 0.45.0 まで、開発ビルド限定の道具（実機確認を回すヘルパー）を
// 束から落とすための印を埋めていた。道具ごと撤去したので不要になった
// （作者の指示、2026-09-10。設計書6.26）

/**
 * 束の設定（拡張機能の2つ・MCPサーバー・MP3 の部品・画面の部品）。
 *
 * **同梱表示（THIRD-PARTY-NOTICES.md）を作るスクリプトも、これを読む**
 * （`scripts/bundledPackages.mjs`）。束に何が入るかは `external`・`alias` で
 * 変わる（ブラウザ束は `undici` を外し、`path` を `path-browserify` へ
 * 差し替える）ので、設定を写すと、束と表示の中身が食い違う日が来る。
 */
function bundleOptions() {
  const desktop = {
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
  };

  const browser = {
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
  };

  /**
   * 外から呼ぶ束（MCPサーバー。設計書6.87.8）。
   *
   * **拡張機能と同時に作り直す。** 別の手順にすると忘れ、**古い束を
   * 使い回して「直したはずの不具合が再現する」**（6.87.6 の4）。
   *
   * `external: []`——SDKごと1ファイルに束ねる。ここで何かを外へ出すと、
   * `node dist/mcp-server.mjs` が読み込んだ瞬間に解決できずに落ちる。
   * `vscode` が混ざっていればここで気づける（`test/unit/cross/mcpReach.test.ts`
   * が静的importからも見ているので、二重に見張っている）。
   *
   * **配布物には入れない**（`.vscodeignore`）。拡張機能そのものは使わない。
   */
  const mcp = {
    entryPoints: ["src/mcp/server.ts"],
    bundle: true,
    format: "esm",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/mcp-server.mjs",
    external: [],
    /*
      **配るスキルの本文（docs/skills/novel-assist.md）を文字列として埋め込む**
      （`src/mcp/skills.ts`）。製品では束を保管庫へ写してから起こすので、
      束の隣のファイルを読む道は届かない。拡張機能の2つの束には入れない
    */
    loader: { ".md": "text" },
    /*
      **ESM の束に `require` を持たせる**（2026-10-03、出先の原稿箱 6.115）。
      本文の書き戻し（`core/textEncodePreserving.ts`）が使う `iconv-lite` は CommonJS で、
      中で `require("buffer")` を呼ぶ。ESM の束には `require` が無いので、
      読み込んだ瞬間に「Dynamic require of "buffer" is not supported」で落ちた
      （`scripts/smokeMcp.mjs` で確かめた）。Node の組み込みだけを解決させる定番の形
    */
    banner: {
      js: 'import { createRequire as __novelaiCreateRequire } from "node:module"; const require = __novelaiCreateRequire(import.meta.url);',
    },
    logLevel: "info",
  };

  /**
   * MP3 の変換の部品（LAME の JavaScript 版 `@breezystack/lamejs`。設計書6.42.4）。
   *
   * **拡張機能の束へ混ぜず、別のファイル `dist/lame.js` にする。** LAME は LGPL-3.0 で、
   * LAME 自身が「別のファイルとして結んで使う」形を勧めている。別のファイルなら、利用者が
   * この部品だけを差し替えられる。**縮めない**（中身を読める形で配る）。
   * 拡張機能は音声の書き出しのときだけ、このファイルを読む（`extension.ts` の `loadMp3Encoder`）。
   * 同梱表示（`scripts/bundledPackages.mjs`）もこの設定を読むので、表示から抜けない。
   */
  const lame = {
    entryPoints: ["src/vendor/lameEntry.ts"],
    bundle: true,
    format: "cjs",
    minify: false,
    sourcemap: false,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/lame.js",
    external: [],
    logLevel: "info",
  };

  /**
   * 画面（WebView）の中で使う部品（`@vscode-elements/elements`。作者の決定 2026-11-15）。
   *
   * **拡張機能の束へ混ぜず、別のファイル `dist/webview-elements.js` にする。** この部品は
   * 読み込まれた瞬間に `customElements.define` を呼ぶ。拡張機能が動く所（拡張機能ホスト）には
   * `customElements` が無いので、拡張機能の束に入ると起動した瞬間に落ちる。画面は
   * `<script nonce="…" src="asWebviewUri(dist/webview-elements.js)">` で読む
   * （手元でもブラウザ版でも同じ形。`extension.ts` から届かないことは
   * `test/unit/cross/webviewElementsReach.test.ts` が見張る）。
   *
   * **入れる部品は使う分だけ**（入口 `src/vendor/webviewElementsEntry.ts`）。全部入りにすると
   * 束が数倍になり、配布物が重くなる。`iife` にして、画面の名前空間へ何も漏らさない。
   * 同梱表示（`scripts/bundledPackages.mjs`）もこの設定を読むので、表示から抜けない。
   */
  const webviewElements = {
    entryPoints: ["src/vendor/webviewElementsEntry.ts"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    target: "es2022",
    outfile: "dist/webview-elements.js",
    external: [],
    logLevel: "info",
  };

  return { desktop, browser, mcp, lame, webviewElements };
}

/**
 * 束ねずに**そのまま写して**配るもの（作者の決定 2026-11-15「ボタンのアイコンは有り」）。
 *
 * 画面のボタンのアイコン（codicon）は字形のフォントと、それを使う CSS の2つでできている。
 * CSS とフォントは esbuild の束にできないので、`node_modules` から `dist/codicons/` へ写す。
 * 画面は `<link id="vscode-codicon-stylesheet" href="asWebviewUri(dist/codicons/codicon.css)">` で読む
 * （部品 vscode-icon がこの id を探す）。CSS の中の `./codicon.ttf` は同じフォルダーを指すので、
 * 2つは同じフォルダーへ置く。
 *
 * **同梱表示（`scripts/bundledPackages.mjs`）も、配布物の許可リスト（`scripts/releaseSupport.mjs`）も
 * この一覧を読む。** 束の中身から作る表示では、写したものは拾われないため。
 */
const COPIED_ASSETS = [
  {
    package: "@vscode/codicons",
    from: "node_modules/@vscode/codicons/dist/codicon.css",
    to: "dist/codicons/codicon.css",
  },
  {
    package: "@vscode/codicons",
    from: "node_modules/@vscode/codicons/dist/codicon.ttf",
    to: "dist/codicons/codicon.ttf",
  },
];

function copyAssets() {
  const fs = require("fs");
  const path = require("path");
  for (const asset of COPIED_ASSETS) {
    const target = path.join(__dirname, asset.to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, asset.from), target);
  }
}

async function main() {
  copyAssets();
  const options = bundleOptions();
  const contexts = await Promise.all(
    [options.desktop, options.browser, options.mcp, options.lame, options.webviewElements].map((config) =>
      esbuild.context(config)
    )
  );

  if (watch) {
    await Promise.all(contexts.map((context) => context.watch()));
  } else {
    await Promise.all(contexts.map((context) => context.rebuild()));
    await Promise.all(contexts.map((context) => context.dispose()));
  }
}

module.exports = { bundleOptions, COPIED_ASSETS };

// `require` で読まれたとき（同梱表示のスクリプト・テスト）は、ビルドしない
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
