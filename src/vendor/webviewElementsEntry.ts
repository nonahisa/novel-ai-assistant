/**
 * 画面（WebView）の部品の入口（作者の決定 2026-11-15「vscode-elements を足す」）。
 * `esbuild.js` の `webviewElements` がこれを `dist/webview-elements.js` に束ね、画面が
 * `<script nonce="…" src="…">` で読む。
 *
 * **拡張機能の束（`dist/extension.js`・`dist/browser-extension.js`）からは import しない。**
 * 部品は読み込まれた瞬間に `customElements.define` を呼ぶが、拡張機能ホストには
 * `customElements` が無く、起動した瞬間に落ちる（`webviewElementsReach.test.ts` が見張る）。
 *
 * **使う部品だけを並べる。** 全部入り（`bundled.js`）にすると束が数倍になる。いまは
 * 執筆統計のボタンと折りたたみだけ。画面を置き換えるときに1行ずつ足す。
 */
// TypeScript 7 は、CommonJS の設定のまま ESM 専用の部品を import すると TS1479 で止める。
// このファイルは tsc では実行せず esbuild が束ねるだけ（副作用の import）なので、型検査のときだけ黙らせる。
// @ts-ignore TS1479
import "@vscode-elements/elements/dist/vscode-button/index.js";
// @ts-ignore TS1479
import "@vscode-elements/elements/dist/vscode-collapsible/index.js";
