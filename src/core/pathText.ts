import * as nodePath from "path";
import { isWindowsHost } from "./runtime";

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
 * URI の道に入った百分率符号を解く（2026-09-24）。**手元の道はそのまま返す。**
 *
 * **同じ場所でも、どこから来たかで表記が割れる。**
 *
 * - 書庫の中を読んだ名前を `join` でつないだ場所——**生の日本語**
 *   （`vscode-test-web://mount/仮作品`）
 * - 開いた本文の場所（`paths.fromUri(document.uri)`）——非 `file:` では
 *   `uri.toString()` になり、**日本語が符号化される**（`%E4%BB%AE…`）
 *
 * 比べる前と、画面に名前を出す前に通す。**持ち回る場所そのものは
 * 書き換えない**——符号化された形を `toUri` で開ける形のまま残すため。
 *
 * **区画（`/` の間）ごとに解き、解けない区画はそのまま残す。**
 * `50%OFF` のように `%` を含むだけの名前で `decodeURIComponent` は例外を
 * 投げる。まとめて解くと、その1区画のせいでほかの区画まで符号化のまま残る。
 *
 * 手元の道（`C:\…`・`/home/…`）の `%` は名前の一部なので解かない。
 */
export function decodeUriEscapes(location: string): string {
  if (!isUriString(location) || !location.includes("%")) return location;
  const { head, body } = splitUri(location);
  return head + body.split("/").map(decodeSegment).join("/");
}

function decodeSegment(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    const decoded = decodeURIComponent(segment);
    // `%2F` を解くと区切りが増えて別の道になる。名前に `/` は入らないので、
    // そう解ける区画は符号のまま残す
    return decoded.includes("/") ? segment : decoded;
  } catch {
    return segment;
  }
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
  // 保証は無いので、無ければ大文字小文字を区別する側へ倒す（判定は
  // `runtime.ts` の1か所。**この正規化をほかへ書き写さない**——写しが
  // 8か所あり、どれも分け方を落としてブラウザ版で落ちた。2026-09-23）
  return isWindowsHost() ? normalized.toLowerCase() : normalized;
}

/**
 * **ファイルが同じ場所か**を比べるための鍵（2026-09-24）。
 *
 * `normalizeForComparison` の前に、URI の百分率符号を解く（`decodeUriEscapes`）。
 * ブラウザ版では、登録簿や `join` で組んだ場所は生の日本語、
 * `fromUri(document.uri)` は符号化された形で来る。`normalizeForComparison`
 * どうしを `===` で比べていた所では、開いている文書を探しても見つからず、
 * 日本語の名前の作品や話が「別の場所」になっていた。
 *
 * **2つの場所を比べる所は、これ（か `isSamePath`）を通す。** 鍵を先に作って
 * ループの中で比べる所のために、鍵だけでも取り出せるようにしてある。
 *
 * **`normalizeForComparison` そのものは変えない。** 回復先の名前
 * （`atomicWrite.ts` の `recoveryKey`）の鍵に使われており、変えると
 * すでに退避してある控えが見つからなくなる。手元の道はここでも
 * 今までと同じ鍵になる（`decodeUriEscapes` は手元の道に触れない）。
 */
export function pathKeyForComparison(location: string): string {
  return normalizeForComparison(decodeUriEscapes(location));
}

/**
 * 2つのファイルが同じ場所か（`pathKeyForComparison` で比べる）。
 * **どちらかが空なら false**——場所が分からないものを同じとは言わない
 * （空の道は `normalize` で `.` に化け、空どうしが一致してしまう）。
 *
 * `core/locationCompare.ts` の `isSameLocation` は Git の作業場の判定用で、
 * 手元の道しか来ない（ブラウザ版では Git が動かない）。**場所を比べる
 * ほかの所はここを使う。**
 */
export function isSamePath(left: string, right: string): boolean {
  if (!left || !right) return false;
  return pathKeyForComparison(left) === pathKeyForComparison(right);
}

/**
 * フォルダーの場所を、登録簿へ入れる形に整える（2026-09-24）。
 *
 * **前後の空白と末尾の区切りだけを落とす。** 大小は変えない——大小まで
 * 畳むと、作者が見ているフォルダー名と作品一覧の表記が食い違う。
 *
 * 作者は、エクスプローラーのアドレス欄から場所を貼る。そのとき空白や
 * 末尾の `\` が紛れ込み、`path.normalize` だけではどちらも残る。
 *
 * **根は区切りを残す**（`C:\`・`/`・`vscode-vfs://github/`）。`C:\` を
 * `C:` にすると、Windows では「そのドライブの、いまの場所」という
 * 別の意味に変わる。
 */
export function tidyFolderPath(location: string): string {
  const trimmed = location.trim();
  if (!trimmed) return "";
  return stripTrailingSeparators(normalize(trimmed));
}

function stripTrailingSeparators(location: string): string {
  if (isUriString(location)) {
    const { head, body } = splitUri(location);
    // 道は `/` から始まる。全部が斜線なら根なので `/` を1つ残す
    return head + (body.replace(/\/+$/u, "") || "/");
  }
  const root = nodePath.parse(location).root;
  let end = location.length;
  // Windows の `path` は `/` も区切りとして読む。posix では `\` は名前の一部
  while (
    end > root.length &&
    (location[end - 1] === nodePath.sep || location[end - 1] === "/")
  ) {
    end--;
  }
  return location.slice(0, end);
}

/**
 * **フォルダーが同じ場所か**を比べるための鍵（2026-09-24）。
 *
 * `normalizeForComparison` に、前後の空白と末尾の区切りを落とすことを
 * 足したもの。作品の登録簿の重複を `path.normalize` の完全一致で見ていたので、
 * 次がすべて「別の場所」になり、**同じ作品を二重に登録できた**（作者の報告）。
 *
 * - ドライブ文字の大小（フォルダー選びは `c:`、アドレス欄から貼ると `C:`）
 * - 末尾の `\`
 * - フォルダー名の大小（Windows では同じフォルダー）
 * - 前後の空白
 *
 * **登録簿の場所を比べる所は、すべてこれ（か `isSameFolder`）を通す。**
 * 登録は断るのに探すと見つからない、というずれを作らないため。
 * ファイルの場所を比べるなら `normalizeForComparison` のままでよい
 * （ファイルの道に末尾の区切りは付かない）。
 *
 * 空（空白だけを含む）なら空文字を返す。
 *
 * **URI の日本語は符号を解いてから鍵にする**（`pathKeyForComparison`。
 * 2026-09-24）。ブラウザ版では、フォルダー選びで登録した場所は符号化の形、
 * 書庫から登録した場所は生の日本語になり、同じ作品を二重に登録できた。
 * 登録簿へ入れる形（`tidyFolderPath`）は変えない——符号化の形のまま残すのは、
 * `toUri` で開ける形を崩さないため。
 */
export function folderKeyForComparison(location: string): string {
  const tidy = tidyFolderPath(location);
  return tidy ? pathKeyForComparison(tidy) : "";
}

/**
 * 2つのフォルダーが同じ場所か（`folderKeyForComparison` で比べる）。
 * **どちらかが空なら false**——場所が分からないものを同じとは言わない。
 */
export function isSameFolder(left: string, right: string): boolean {
  const a = folderKeyForComparison(left);
  return a.length > 0 && a === folderKeyForComparison(right);
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

/**
 * `candidate` が `parent` の**中**にあるか。**同じ場所は false**（中身ではなく、そのもの）。
 *
 * **この判定の写しが7か所あった**（2026-09-23 に寄せた）。正規化は
 * `normalizeForComparison` へ寄せ終えていたが、判定は別々のままで、
 * そのうち2か所は `relative.startsWith("..")` で外かどうかを決めていた。
 * **それだと `..下書き` のように「..」で始まる名前のフォルダーを、
 * 中にあるのに外と誤判定する。** 区切りまで見る `goesOutside` を通す。
 *
 * - **前方一致では足りない**——`いじめられっ子2` は `いじめられっ子` の中ではない
 * - 大文字小文字は、Windows のときだけ同一視する（`normalizeForComparison`）
 * - 仕組みや場所の違う URI、別のドライブは、相対で表せないので「外」
 * - **URI の日本語は、符号を解いてから比べる**（`decodeUriEscapes`。2026-09-24）。
 *   登録簿の場所は生の日本語、開いた本文の場所は符号化された形で来るので、
 *   そのまま比べるとブラウザ版では作品の中の本文がすべて「外」になっていた
 *   （下の欄に種類の目安も今日の執筆量も出なかった）
 * - **空文字はどちらでも false。** 空の道は `normalize` で `.`（いまの場所）に
 *   化け、たまたま中と答えうる。場所が分からないものを中とは言わない
 *
 * **ここへ写しを作らない。** `test/unit/core/pathInside.test.ts` が、`src` の中で
 * 自前の判定（`function isPathInside` / `function isInside`）を定義していたら落とす。
 */
export function isPathInside(parent: string, candidate: string): boolean {
  if (!parent || !candidate) return false;
  // 符号を解くのは比べる鍵（`pathKeyForComparison`）の中だけ。
  // `normalizeForComparison` は回復先の名前（`atomicWrite.ts` の
  // `recoveryKey`）の鍵にも使われており、そちらを変えると、すでに
  // 退避してある控えが見つからなくなる
  const base = pathKeyForComparison(parent);
  const target = pathKeyForComparison(candidate);
  const rel = relative(base, target);
  return rel.length > 0 && !goesOutside(base, rel);
}
