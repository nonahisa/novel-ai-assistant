/**
 * いまどこで動いているか、そこで何が使えるかを1か所にまとめる（設計書5.8）。
 *
 * この拡張機能は2つの場所で動く。
 *
 * - **手元のVS Code**（Windows / Mac / Linux、Codespaces などのリモート接続も含む）
 *   Node が居るので、外部プロセス（git・Ollama）を起動できる
 * - **ブラウザのVS Code**（vscode.dev / github.dev）
 *   Web Worker の中で動く。**Node が無い。** 外部プロセスは原理的に起動できない
 *
 * **判定を散らさない。** `typeof process` をあちこちで書くと、
 * 片方でしか通らない道が黙って増える（この作品で何度も踏んでいる形）。
 */

/**
 * ブラウザのVS Code（vscode.dev / github.dev）で動いているか。
 *
 * **`process` があるかで見る。** ブラウザ版は Web Worker なので `process`
 * が無い。esbuild の `platform: "browser"` は `process` を詰め物で
 * 埋めないので、そのまま判定に使える。
 */
export function isWebRuntime(): boolean {
  return typeof process === "undefined" || !process.versions?.node;
}

/**
 * 外部プロセスを起動できるか。
 *
 * git・Ollama・パッケージ導入がこれを見る。**ブラウザでは常に false** で、
 * それらの機能は操作メニューに出さない（押せるのに必ず失敗する、を作らない）。
 */
export function canRunProcesses(): boolean {
  return !isWebRuntime();
}

/**
 * 重ならない一意な文字列。
 *
 * `crypto.randomUUID()` は Node にもブラウザにもある（ブラウザでは
 * `globalThis.crypto`）。**`require("crypto")` では取らない。**
 */
export function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * 短い乱数（16進）。端末の見分け札などに使う。
 *
 * `crypto.randomBytes` は Node だけなので、`getRandomValues` で取る。
 */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * いま動いている拡張機能ホストを見分ける札。
 *
 * 一時ファイルの名前に混ぜて、**同じ作品を2つの窓で開いていても
 * 一時ファイルがぶつからない**ようにするために使う。Node なら
 * プロセス番号、ブラウザならこの読み込みごとに1つ作る。
 */
const HOST_TAG = isWebRuntime() ? randomHex(3) : String(process.pid);

export function hostTag(): string {
  return HOST_TAG;
}
