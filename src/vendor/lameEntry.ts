/**
 * MP3 の変換の部品の入口（設計書6.42.4）。`esbuild.js` の `lame` がこれを
 * `dist/lame.js` に束ねる。**拡張機能の束（`dist/extension.js`）からは import しない**——
 * LGPL-3.0 の部品を別のファイルのまま配り、差し替えられるようにするため。
 * 拡張機能は音声の書き出しのときだけ `dist/lame.js` を読む（`extension.ts` の `loadMp3Encoder`）。
 */
export { Mp3Encoder } from "@breezystack/lamejs";
