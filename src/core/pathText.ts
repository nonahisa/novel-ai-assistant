import * as nodePath from "path";

/**
 * 場所の文字列だけを扱う部分（`paths.ts` の中身のうち、`vscode` が要らないもの）。
 *
 * **分けた理由は、外から呼べるようにするため**（設計書6.87.3）。`paths.ts` は
 * `Uri` を作る `toUri` / `fromUri` を持つので `vscode` を import している。
 * そのため、`basename` を1つ借りるだけの `episodeParser.ts` まで `vscode`
 * 依存になり、そこを通る系（話数の見出しなど）が Node 単体で動かなかった。
 *
 * **使う側の指針は変わらない。**`paths.ts` がここを丸ごと再輸出するので、
 * これまでどおり `import * as path from "../core/paths"` と書いてよい。
 * **`vscode` を持ち込まない `core` の部品だけ**、ここを直に指す。
 *
 * 中身の考え方（なぜ文字列のまま扱うか、なぜ posix を使うか）は `paths.ts`
 * の冒頭に書いてある。
 */

/**
 * URIの文字列に見えるか。
 *
 * **Windowsのドライブ文字（`C:`）と見分ける必要がある。** 仕組みの名前を
 * 2文字以上とすることで分けている（1文字の仕組み名は実在しない）。
 *
 * **場所（authority）が無い形も認める**（0.51.3。0.47.4 の積み残し④）。
 * `vscode-vfs://github/…` は斜線2本だが、**拡張機能の保管庫は
 * `vscode-userdata:/User/…` で斜線が1本**である（authority が空）。
 * 2本を必須にしていたので、ブラウザ版では保管庫の道が「OSのパス」として
 * 扱われ、`join` が `\` で繋いで別の場所を指していた。その結果、
 * 生成文書（使い方・はじめの案内など）が必ず無題文書へ落ちていた。
 *
 * 斜線1本を認めても、ドライブ文字とは取り違えない——`C:/x` の仕組み名は
 * 1文字なので、上の「2文字以上」で先に弾かれる。
 */
const URI_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]+:\/\/?/;

export function isUriString(value: string): boolean {
  return URI_LIKE.test(value);
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
  // **場所（authority）は在ることも無いこともある。**
  //   vscode-vfs://github/owner/repo/x → 頭 `vscode-vfs://github` ／ 道 `/owner/repo/x`
  //   vscode-userdata:/User/x          → 頭 `vscode-userdata:`    ／ 道 `/User/x`
  const match =
    /^([a-zA-Z][a-zA-Z0-9+.-]+:(?:\/\/[^/?#]*)?)([^?#]*)/.exec(location);
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
 * 以前は `Uri.file` から `fsPath` を取る形を経由していた箇所が3つあった。
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
