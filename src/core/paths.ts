import * as vscode from "vscode";
import * as nodePath from "path";

/**
 * 手元のファイルと、ブラウザ上の作品を、同じ書き方で扱う（設計書5.8）。
 *
 * **ブラウザのVS Code（vscode.dev / github.dev）では、作品は
 * `file:` のところに無い。** GitHubのリポジトリを開くと、作品の場所は
 *
 *   vscode-vfs://github/nonahisa/mynovel/本文/001.txt
 *
 * になる。`vscode.Uri.file()` はこれを作れないし、`path.join()` は
 * `//` を潰してしまう。
 *
 * この作品はファイルの場所を **`string`** で持ち回っている（`folderPath`、
 * `filePath`）。**全部を `Uri` に変えるのは、原稿を触る処理を丸ごと
 * 書き直すことになって危ない。** そこで、文字列のままで両方を扱えるようにする。
 *
 * - 手元のファイル → これまでどおり `C:\Users\...` や `/home/...`
 * - ブラウザ上の作品 → `vscode-vfs://github/...` という**URIそのものの文字列**
 *
 * `path` と同じ名前・同じ形にしてあるので、**使う側は import を
 * 差し替えるだけ**で済む。呼び出しを1つずつ直すと取り違える。
 */

/**
 * URIの文字列に見えるか。
 *
 * **Windowsのドライブ文字（`C:`）と見分ける必要がある。** 仕組みの名前を
 * 2文字以上とすることで分けている（1文字の仕組み名は実在しない）。
 */
const URI_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//;

export function isUriString(value: string): boolean {
  return URI_LIKE.test(value);
}

/**
 * 場所の文字列から `Uri` を作る。
 *
 * **`vscode.Uri.file()` を直に呼ばない。** ブラウザ上の作品に対して
 * 呼ぶと、存在しない `file:` の場所を指してしまう。
 */
export function toUri(location: string): vscode.Uri {
  return isUriString(location)
    ? vscode.Uri.parse(location, true)
    : vscode.Uri.file(location);
}

/**
 * `Uri` から、持ち回る文字列に戻す。
 *
 * 手元のファイルはこれまでどおり OS のパス。それ以外はURIの文字列。
 * **`toUri` と往復して同じものに戻る**ことをテストが確かめる。
 *
 * **仕組み（scheme）が分からないものは、OS のパスに倒す。**
 * `toString()` に倒すと、`Uri` でないものが渡ったときに
 * `"[object Object]"` という文字列を静かに作ってしまう。この関数は
 * **原稿の保存先を決める道に居る**ので、判断できないときは
 * 「これまでと同じ（`fsPath`）」へ倒すほうが安全である。
 * 実際、テストの作り物の文書（`uri` に scheme を持たない）で
 * 未保存の検出が丸ごと効かなくなった（2026-08-21）。
 */
export function fromUri(uri: vscode.Uri): string {
  if (uri.scheme && uri.scheme !== "file") return uri.toString();
  return uri.fsPath;
}

/**
 * URIを「仕組み＋場所」と「中の道」に割る。
 *
 * **`vscode.Uri.parse` を通さず、文字列として割る。** 通すと、道の部分が
 * 伏せ字を解いた形に変わって往復で一致しなくなるうえ、
 * **この部品が VS Code の有無に縛られる**（テストが書きにくくなる）。
 *
 * クエリ（`?`）と断片（`#`）はファイルの場所には付かないので、
 * 道の終わりとして扱う。
 */
function splitUri(location: string): { head: string; body: string } {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]+:\/\/[^/?#]*)([^?#]*)/.exec(location);
  if (!match) return { head: "", body: location };
  return { head: match[1], body: match[2] || "/" };
}

/** `path` の posix 版だけを使う。URIの中の道は必ず `/` 区切りである */
const posix = nodePath.posix;

export function join(...parts: string[]): string {
  const [first] = parts;
  if (first !== undefined && isUriString(first)) {
    const { head, body } = splitUri(first);
    // **クエリと断片は落とす。** ファイルの場所に付いていることは無く、
    // 付いたまま繋ぐと別の場所を指す
    return head + posix.join(body, ...parts.slice(1));
  }
  return nodePath.join(...parts);
}

export function basename(location: string, suffix?: string): string {
  if (isUriString(location)) {
    return posix.basename(splitUri(location).body, suffix);
  }
  return nodePath.basename(location, suffix);
}

export function dirname(location: string): string {
  if (isUriString(location)) {
    const { head, body } = splitUri(location);
    return head + posix.dirname(body);
  }
  return nodePath.dirname(location);
}

export function extname(location: string): string {
  if (isUriString(location)) {
    return posix.extname(splitUri(location).body);
  }
  return nodePath.extname(location);
}

export function normalize(location: string): string {
  if (isUriString(location)) {
    const { head, body } = splitUri(location);
    return head + posix.normalize(body);
  }
  return nodePath.normalize(location);
}

export function isAbsolute(location: string): boolean {
  // URIは常に場所が確定している
  if (isUriString(location)) return true;
  return nodePath.isAbsolute(location);
}

export function resolve(...parts: string[]): string {
  // **後ろから見て、最初に見つかった「確定した場所」から組み立てる。**
  // `path.resolve` と同じ考え方
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isUriString(parts[i])) {
      return join(parts[i], ...parts.slice(i + 1));
    }
  }
  return nodePath.resolve(...parts);
}

export function relative(from: string, to: string): string {
  if (isUriString(from) || isUriString(to)) {
    // **仕組みか場所が違えば、たどり着けない。** 相対では表せないので
    // 行き先をそのまま返す（`path.relative` も別のドライブでこうする）
    if (!isUriString(from) || !isUriString(to)) return to;
    const a = splitUri(from);
    const b = splitUri(to);
    if (a.head !== b.head) return to;
    return posix.relative(a.body, b.body);
  }
  return nodePath.relative(from, to);
}

/**
 * 区切り文字。
 *
 * **URIの中は必ず `/`** である。手元のファイルは OS に合わせる。
 * ここを見て分岐している処理があるため、場所を渡して選べるようにした。
 */
export function separatorFor(location: string): string {
  return isUriString(location) ? "/" : nodePath.sep;
}

export const sep = nodePath.sep;

/**
 * 「同じ場所を指しているか」を比べるための正規化。
 *
 * 以前は `vscode.Uri.file(x).fsPath` を経由していた箇所が3つあった。
 * **ブラウザ上の作品に対して呼ぶと、存在しない `file:` の場所を
 * 指すUriができる。** 手元のファイルでは、Windowsのドライブ文字を
 * 大文字小文字問わず比べるのと同じ結果になる（このあと呼び出し側で
 * 全体を小文字化するため、`Uri.file` が行うドライブ文字だけの
 * 小文字化と最終的な文字列は変わらない）。
 */
export function normalizeForComparison(location: string): string {
  const normalized = normalize(location);
  // **ブラウザ版には `process` が無い。** 有ってもWindowsか判定できる
  // 保証は無いので、無ければ大文字小文字を区別する側へ倒す
  const isWindows =
    typeof process !== "undefined" && process.platform === "win32";
  return isWindows ? normalized.toLowerCase() : normalized;
}

/**
 * `relative` が、`base` の外を指しているか。
 *
 * `relative(base, candidate)` の結果に対して使う。**`..${path.sep}` を
 * 直に書いている箇所が5つあった。** `path.sep` は常にOSの区切り
 * （Windowsなら `\`）だが、`relative()` はブラウザ上の作品に対しては
 * 常に `/` 区切りを返す。**区切りを取り違えると、作品の外のファイルを
 * 「中にある」と誤判定する。** 判定をここへ集め、`base` から
 * 正しい区切りを選ばせる。
 */
export function goesOutside(base: string, relative: string): boolean {
  const separator = separatorFor(base);
  return (
    relative === ".." ||
    relative.startsWith(`..${separator}`) ||
    isAbsolute(relative)
  );
}
