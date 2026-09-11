/**
 * 場所どうしの比べ方（設計書5.6）。
 *
 * **VS Code に依存させない。** `git.ts` から使うためである
 * （`git.ts` は実際のgitを動かして確かめられるよう vscode を持ち込まない）。
 *
 * 同じ判定を2か所で書いていたことがあり、**片方だけが大文字小文字を
 * そろえていた**。編集用フォルダーの置き場は作者がダイアログで選ぶので、
 * 登録時の `folderPath` と綴りだけが違う道になりうる——そこがすり抜けると
 * 入れ子のリポジトリができる。判定はここ1か所に置く。
 */

/**
 * 比べるための形に揃える。
 *
 * 区切りの円記号を `/` に直し、末尾の `/` を落とす。
 * 正規表現の中の円記号は読みにくいので符号（u005C）で書く。
 *
 * **Windowsでは大文字小文字を同じものとして見る。** 同じフォルダーを
 * `C:\Novels\...` とも `c:\novels\...` とも書けるためである。
 * ブラウザ版には `process` が無く、有ってもWindowsか判定できる保証は
 * 無いので、無ければ区別する側へ倒す（`paths.normalizeForComparison`
 * と同じ判断）。
 */
function normalize(value: string): string {
  const unified = value.replace(/[\u005C]/g, "/").replace(/[/]+$/, "");
  const isWindows =
    typeof process !== "undefined" && process.platform === "win32";
  return isWindows ? unified.toLowerCase() : unified;
}

/** 同じ場所を指しているか。Windowsでは大文字小文字を同じものとして見る */
export function isSameLocation(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

/**
 * `child` が `parent` の中にあるか。**同じ場所も「中」として扱う。**
 *
 * 編集用フォルダーの置き場を決めるときに使う。作品フォルダーそのものを
 * 選ばれても、リポジトリが入れ子になることに変わりはない。
 *
 * **区切りを足してから比べる。** 素の `startsWith` だと、「いじめ」の中に
 * 「いじめられっ子」が入っていることになる。
 */
export function isNestedLocation(child: string, parent: string): boolean {
  const inner = normalize(child);
  const outer = normalize(parent);
  if (inner === outer) return true;
  return inner.startsWith(`${outer}/`);
}
