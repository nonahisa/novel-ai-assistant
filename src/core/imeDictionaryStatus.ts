import * as vscode from "vscode";
import * as path from "path";
import { DICTIONARY_FORMATS } from "./imeDictionary";
import { SETTINGS_DIRECTORY_NAMES } from "./externalChanges";

/**
 * 書き出したIME辞書が古くなっていないかを調べる（設計書6.13）。
 *
 * 辞書は書き出したあと、作者が自分でIMEへ取り込む。取り込みを自動化する
 * 手段はどのIMEにも無い（6.13.5）。そのため**設定資料を増やしても、
 * 辞書を書き出し直すまで新しい語は変換に出てこない。**
 * 作者から見ると「抽出したのに変換に出ない」としか見えず、
 * 原因が「書き出し直していないから」だとは気づけない。
 *
 * そこで「設定資料のほうが辞書より新しい」ことを見つけて、
 * 操作メニューの印で知らせる。
 *
 * **中身ではなく更新時刻で比べる。** 中身で比べるには設定資料のJSONを
 * 全件読んで辞書を組み立て直す必要がある（実データでは1作品あたり
 * 数百ファイル）。知りたいのは「書き出し直す必要があるか」だけなので、
 * そこまでの費用を払う価値がない。時刻の比較なら stat だけで済む。
 *
 * 取りこぼしはある（設定を書き換えて元に戻した場合など）が、
 * 出るのは「書き出し直しませんか」という印だけで、実害が無い方向に外れる。
 */

/** 一度も書き出していない作品は「古い」と言わない（催促にならないため） */
export interface DictionaryFreshness {
  /** 書き出し済みの辞書があるか */
  exported: boolean;
  /** 設定資料のほうが新しいか */
  stale: boolean;
}

/** そのフォルダ直下で、いちばん新しい更新時刻。1つも無ければ undefined */
async function newestMtime(directory: string): Promise<number | undefined> {
  let newest: number | undefined;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(
      vscode.Uri.file(directory)
    );
  } catch {
    // フォルダがまだ無い作品もある。その場合は比べる材料が無いだけ
    return undefined;
  }

  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File) continue;
    if (!name.endsWith(".json")) continue;
    try {
      const stat = await vscode.workspace.fs.stat(
        vscode.Uri.file(path.join(directory, name))
      );
      if (newest === undefined || stat.mtime > newest) newest = stat.mtime;
    } catch {
      // 読めないファイルは飛ばす。印が出ないだけで実害はない
    }
  }
  return newest;
}

/**
 * 設定資料と書き出し済み辞書の新しさを比べる。
 *
 * @param settingsDir 作品の「設定」フォルダ
 */
export async function checkDictionaryFreshness(
  settingsDir: string
): Promise<DictionaryFreshness> {
  // 書き出し済みの辞書のうち、いちばん新しいもの
  let newestDictionary: number | undefined;
  for (const format of Object.values(DICTIONARY_FORMATS)) {
    try {
      const stat = await vscode.workspace.fs.stat(
        vscode.Uri.file(path.join(settingsDir, format.fileName))
      );
      if (newestDictionary === undefined || stat.mtime > newestDictionary) {
        newestDictionary = stat.mtime;
      }
    } catch {
      // その形式では書き出していない。よくあることなので何もしない
    }
  }

  if (newestDictionary === undefined) {
    return { exported: false, stale: false };
  }

  // 設定資料のうち、いちばん新しいもの
  let newestSettings: number | undefined;
  for (const name of SETTINGS_DIRECTORY_NAMES) {
    const found = await newestMtime(path.join(settingsDir, name));
    if (found === undefined) continue;
    if (newestSettings === undefined || found > newestSettings) {
      newestSettings = found;
    }
  }

  if (newestSettings === undefined) {
    return { exported: true, stale: false };
  }

  return { exported: true, stale: newestSettings > newestDictionary };
}
