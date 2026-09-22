import * as vscode from "vscode";
import { isUriString } from "./pathText";
import { canRunProcesses } from "./runtime";

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
 *
 * **中身は2つに分かれている**（設計書6.87.3）。`Uri` を作る `toUri` /
 * `fromUri` だけがここにあり、場所の文字列を組み立てる部分は
 * `pathText.ts` にある。**`vscode` が要らない部品まで `vscode` 依存に
 * しないため**で、ここが丸ごと再輸出するので使う側の書き方は変わらない。
 */

export * from "./pathText";

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
 * 拡張機能の保管庫（`globalStorageUri`）を、持ち回る文字列にする。
 *
 * **同じ `vscode-userdata:` でも、手元とブラウザで扱いが逆になる。**
 * 片方だけ見て直すと、もう片方を壊す（実際に2度踏んだ）。
 *
 * - **手元（デスクトップ）では OS のパスへ倒す。** 拡張機能開発ホストは
 *   `globalStorageUri` を `vscode-userdata:` で渡すが、実体は手元のディスクに
 *   ある。`fromUri` の一般規則（`file:` 以外は URI の文字列）に任せると
 *   `mkdir "C:\vscode-userdata:"` になって落ち、生成文書がすべて無題文書へ
 *   落ちていた（実機で発見、2026-09-05）
 * - **ブラウザ版では URI の文字列のまま持ち回る。** ブラウザでも保管庫は
 *   `vscode-userdata:/User/…` で来るが、実体のディスクは無い。倒すと
 *   `\User\globalStorage\…` という無い道になり、
 *   `No file system handle registered (\User)` で落ちた（2026-09-23）。
 *   文字列のまま `join` などで伸ばせることは `pathUserData.test.ts` が確かめている
 *
 * **判定はここだけに置く。** 以前は生成文書・ログ・AIチューニングの台帳・
 * 保管庫の文字列の4か所に写してあり、どれも「ブラウザ版は `vscode-vfs:`
 * などで来る」と思い込んだまま同じ穴を抱えていた（`storageRoot.test.ts`
 * がほかへ写すのを止める）。
 *
 * `desktop` は試験のための口。テストは Node で動くので、`canRunProcesses()`
 * は常に true になり、ブラウザの道を確かめられない。
 */
export function storageRootFrom(
  uri: vscode.Uri,
  desktop: boolean = canRunProcesses()
): string {
  return uri.scheme === "vscode-userdata" && desktop
    ? uri.fsPath
    : fromUri(uri);
}
