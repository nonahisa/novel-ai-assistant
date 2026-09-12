import * as vscode from "vscode";
import { isUriString } from "./pathText";

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
