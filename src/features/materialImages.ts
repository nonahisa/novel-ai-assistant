import * as vscode from "vscode";
import * as path from "../core/paths";
import { MATERIALS_DIR, isImageFileName } from "../core/epubImagePick";

/**
 * 素材置き場の画像を集める（作者の指定、2026-09-13）。
 *
 * 人物イラストを名前で引くための材料である。決め方（どれを選ぶか）は
 * `core/characterIconLookup.ts` が持ち、ここは**ファイルを見て並べるだけ**。
 * 分けてあるのは、名前の突き合わせと並びをファイル無しで確かめたいため。
 *
 * **読めなくても例外にしない。** 素材置き場がまだ無い作品はふつうに
 * あるので、その場合は空の一覧を返す（本は名前だけで組まれる）。
 */

/**
 * 掘る深さ。`素材/` の直下を0として数える。
 *
 * 作者の並べ方は決められない（`素材/人物/主要/…` のように分けている人が
 * いる）ので浅すぎると見つからず、際限が無いと戻ってこない。画像を選ぶ
 * 画面の走査（`epubEditorPanel.ts` の `collectWorkImages`）と同じ5にする。
 */
const MAX_DEPTH = 5;

/** 集める上限。素材置き場を写真の倉庫にしている作者でも戻ってくるように */
const MAX_FILES = 2000;

/**
 * `素材/` の下の画像を、作品フォルダからの相対パス（`/` 区切り）で返す。
 *
 * 並びはファイルシステムの返す順のままである。**どれを使うかを決めるのは
 * `buildCharacterIconIndex`** なので、ここの順に意味を持たせない。
 */
export async function collectMaterialImages(
  workFolder: string
): Promise<string[]> {
  const found: string[] = [];

  const walk = async (
    current: string,
    relativePrefix: string,
    depth: number
  ): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(path.toUri(current));
    } catch {
      // 素材置き場がまだ無い／読めないだけ。イラストは付かないが本は出る
      return;
    }

    for (const [name, type] of entries) {
      if (found.length >= MAX_FILES) return;
      // 隠しフォルダー（`.git`・`.novelai-recovery`）に作者の絵は無い
      if (name.startsWith(".")) continue;

      const relativePath = `${relativePrefix}/${name}`;
      if (type === vscode.FileType.Directory) {
        await walk(path.join(current, name), relativePath, depth + 1);
        continue;
      }
      if (type !== vscode.FileType.File) continue;
      if (isImageFileName(name)) found.push(relativePath);
    }
  };

  await walk(path.join(workFolder, MATERIALS_DIR), MATERIALS_DIR, 0);
  return found;
}
