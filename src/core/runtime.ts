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
 * 手元の OS の名前（`win32`・`darwin`・`linux` など）。**ブラウザ版では undefined。**
 *
 * **`process` を読むのはこのファイルだけにする**（2026-09-23）。ほかの所で
 * `process.platform` を素で読むと、ブラウザ版では押した瞬間に
 * `process is not defined` で落ちる。実機で「動作診断」（生成文書が
 * 置けなかった）と「バージョンを確認」（窓が出て落ちた）の2つを踏んだ。
 * 根は、場所の比べ方を8か所に書き写し、写すときに分け方を落としたこと。
 * `browserReach.test.ts` がほかでの素の `process` を止める。
 */
export function hostPlatform(): NodeJS.Platform | undefined {
  return isWebRuntime() ? undefined : process.platform;
}

/**
 * Windows の上で動いているか。**分からないとき（ブラウザ版）は false。**
 *
 * 場所の比べ方（大文字小文字を畳むか）は、Mac も含めて下の
 * `isCaseInsensitiveFileNameHost` が決める（0.148.0 で分けた）。
 */
export function isWindowsHost(): boolean {
  return hostPlatform() === "win32";
}

/**
 * ファイル名の大文字小文字を区別しない OS か（場所を比べる前に小文字へ畳むかを決める）。
 *
 * - **Windows（NTFS）と Mac（APFS の既定）は区別しない。** Mac で `touch a.txt A.txt` は
 *   1つのファイルになる（2026-11-08、Mac のセッションが実機で確かめた）。畳まないと、
 *   同じ話を別の場所と読む
 * - **Linux は区別する。** ブラウザ版も分からないので区別する側へ倒す（前からの判断）
 *
 * Mac でも大文字小文字を区別する APFS で作った入れ物はあるが、既定ではないので見ない。
 * VS Code 自身も Linux 以外を「区別しない」として扱っている（ファイルの見張りの比べ方）。
 */
export function isCaseInsensitiveFileNameHost(): boolean {
  const platform = hostPlatform();
  return platform === "win32" || platform === "darwin";
}

/**
 * Mac の上で動いているか（画面に出すキーの書き方を ⌘ にするため。`core/keyLabels.ts`）。
 *
 * **ブラウザ版は、ブラウザの申告（`navigator.userAgent`）で見る。** 拡張機能は
 * Web Worker の中で動き、`process` は無いが `navigator` はある。手元の VS Code では
 * `navigator` を見ない——Node 21 からの `navigator` は「Node.js/24」のような名前しか持たない。
 * リモート接続（Codespaces など）では、ここが見るのは**拡張機能の居る機械**であって、
 * 作者の手元の OS ではない（拡張機能の側からは手元の OS を知る道が無い）。
 */
export function isMacHost(): boolean {
  const platform = hostPlatform();
  if (platform !== undefined) return platform === "darwin";
  const agent = (globalThis as { navigator?: { userAgent?: unknown } }).navigator?.userAgent;
  return typeof agent === "string" && /Macintosh|Mac OS X/.test(agent);
}

/** 環境変数。**ブラウザ版には環境変数が無い**ので、常に undefined */
export function environmentVariable(name: string): string | undefined {
  return isWebRuntime() ? undefined : process.env[name];
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
