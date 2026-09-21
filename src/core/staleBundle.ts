/**
 * 「拡張機能が入れ替わったのに、このウィンドウは古い版を動かしている」
 * ことを、失敗の中身から見分ける（設計書6.106）。
 *
 * VS Code は裏で拡張機能を更新すると**古い版のフォルダーを消す**が、
 * 開いているウィンドウは古い版を動かし続ける。この拡張機能は
 * コマンドの本体を `await import("./features/xxx.js")` で
 * **押されたときに読む**作りなので、押した瞬間に
 * 「もう無いフォルダー」を探しに行って落ちる。
 *
 * 作者の本番で実際に起きた（走っている版 0.69.10、ディスクは 0.72.2 だけ）。
 * 画面には素の「システム エラー」しか出ず、`exthost.log` にこうあった：
 *
 * ```
 * ENOENT: no such file or directory
 * 'c:\Users\nonah\.vscode\extensions\nonahisa.novel-ai-assistant-0.69.10\dist\extension.js'
 * ```
 *
 * **作品ファイルの ENOENT（作者の原稿が消えた等）と取り違えないこと。**
 * そちらは別の失敗で、ウィンドウを再読み込みしても直らない。だから
 * 「ENOENT だから更新された」とは判断せず、**消えた先が拡張機能自身の
 * 置き場（`extensionPath`）の中かどうか**まで見る。
 *
 * `vscode` を import しない（`core` の決まり）。呼び出し側が
 * `context.extensionPath` を渡す。
 */

/**
 * 区切りと大文字小文字の違いを吸収する。
 *
 * 上の実例は `c:\Users\...` と**小文字のドライブ文字**で来た。
 * `context.extensionPath` のほうは `C:\Users\...` で来るので、
 * そのまま比べると一致しない。Windows のパスは大文字小文字を区別せず、
 * 区切りも `\` と `/` が混在するため、両方を均してから比べる。
 */
function normalizePath(text: string): string {
  return text.replace(/\\/g, "/").toLowerCase();
}

/** `code` を持っているかどうかだけを見る（`any` を使わないため） */
function codeOf(error: object): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** `message` を持っているかどうかだけを見る */
function messageOf(error: object): string | undefined {
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

/**
 * この失敗は「拡張機能が入れ替わったせい」か。
 *
 * 真にするのは次のどちらか。
 *
 * 1. `code` が `ERR_MODULE_NOT_FOUND`——動的 import が束そのものを
 *    見つけられなかったときに Node が付ける印で、これ以上の判別は要らない
 * 2. `message` に `ENOENT` を含み、**かつ** 消えた先が `extensionPath` の中
 *
 * それ以外は真にしない。**素の文字列や `undefined` も偽**である
 * （ここへ来るのは Node/VS Code が投げた Error であり、文字列が
 * 飛んでくるのは別の経路＝別の失敗である）。
 */
export function isStaleBundleError(
  error: unknown,
  extensionPath: string
): boolean {
  if (typeof error !== "object" || error === null) return false;

  if (codeOf(error) === "ERR_MODULE_NOT_FOUND") return true;

  const message = messageOf(error);
  if (!message || !message.includes("ENOENT")) return false;

  // 置き場が分からないなら判断しない。空文字はどんな文字列にも
  // 含まれてしまうので、作品ファイルの ENOENT まで巻き込む
  const trimmed = extensionPath.trim();
  if (!trimmed) return false;

  return normalizePath(message).includes(normalizePath(trimmed));
}
