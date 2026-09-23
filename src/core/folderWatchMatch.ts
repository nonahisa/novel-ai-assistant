import {
  basename,
  isPathInside,
  normalizeForComparison,
  relative,
} from "./pathText";

/**
 * フォルダーの見張りの「このファイルは知らせるか」を、コードで判定する
 * （残課題 C2、0.84.4）。
 *
 * **なぜ glob をやめてコードで比べるか。** 作品フォルダーごとの見張りを
 * 1本（`**\/*`）に束ねたので、機能ごとの glob（`**\/*.{txt,md}` など）は
 * VS Code に渡せなくなった。代わりに、届いた知らせを各機能へ配る前に
 * ここで絞る。**VS Code の glob と同じ結果になること**を
 * `test/unit/core/folderWatchMatch.test.ts` が表で確かめている。
 *
 * 大文字小文字の扱いも VS Code に合わせる——VS Code の見張りは、
 * 大文字小文字を区別しないファイルシステム（Windows）では場所も
 * パターンも小文字にしてから比べる。ここでは `normalizeForComparison`
 * （Windows のときだけ小文字にそろえる）を通すので、同じ振る舞いになる。
 *
 * **`vscode` を持ち込まない**（`core` の決まり。`mcpReach.test.ts`）。
 * `paths.ts` ではなく `pathText.ts` を直に指すのはそのため。
 */

/** `RelativePattern(folder, "**\/*")` と同じ：`folder` の下のどこか（`folder` そのものは含まない） */
export function isUnderFolder(folder: string, filePath: string): boolean {
  return isPathInside(folder, filePath);
}

/**
 * `RelativePattern(folder, "**\/*.{a,b}")` と同じ：`folder` の下のどこかにあり、
 * 名前がその拡張子で終わる。
 *
 * `extensions` は点を付けずに小文字で渡す（`["txt", "md"]`）。
 */
export function isUnderFolderWithExtension(
  folder: string,
  filePath: string,
  extensions: readonly string[]
): boolean {
  return isPathInside(folder, filePath) && hasExtension(filePath, extensions);
}

/**
 * `RelativePattern(親, "名前/*.md")` と同じ：`folder` の**直下**にあり、
 * 名前がその拡張子で終わる（1つ下の階層は含まない）。
 */
export function isDirectChildWithExtension(
  folder: string,
  filePath: string,
  extensions: readonly string[]
): boolean {
  if (!isPathInside(folder, filePath)) return false;
  const rel = relative(
    normalizeForComparison(folder),
    normalizeForComparison(filePath)
  );
  // 区切りを含まなければ直下。区切りは OS とURIで違うので両方見る
  if (rel.includes("/") || rel.includes("\\")) return false;
  return hasExtension(filePath, extensions);
}

/**
 * 名前がその拡張子で終わるか。
 *
 * glob の `*.md` は「0文字以上＋.md」なので、`.md` という名前も通る
 * （`extname` は `.md` を「拡張子なし」と答えるので使わない）。
 */
function hasExtension(filePath: string, extensions: readonly string[]): boolean {
  // Windows では小文字にそろった名前が返る（`.MD` も通る）。それ以外では
  // 綴りのまま比べる（`.MD` は通らない）——どちらも VS Code の glob と同じ
  const name = basename(normalizeForComparison(filePath));
  return extensions.some((extension) => name.endsWith(`.${extension}`));
}
