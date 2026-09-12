import * as nodePath from "node:path";
import { parseCollectedFile } from "../../core/collectedFile";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { parseEpisodeMetadata } from "../../core/metadataParser";
import { FOLDER_INPUT, bodyDirOf, listBodyFiles, readBody } from "./shared";

/**
 * 作品フォルダーを走査する（設計書6.87.8 の4）。**読むだけ。**
 *
 * **`core/scanner.ts` は使わない。** あちらは `vscode.workspace.fs` を通る
 * ので束に入らない。代わりに、走査が使っているのと同じ部品——ファイル名の
 * 解析（`parseEpisodeFileName`）・合本の分け方（`parseCollectedFile`）・
 * 頭書きの落とし方（`parseEpisodeMetadata`）——を直に通す。
 */

export const WORK_SCAN_INPUT = { ...FOLDER_INPUT };

export interface ScannedEpisode {
  /** 作品フォルダーからの相対パス。ほかのツールへはこれを渡す */
  filePath: string;
  /** 話数。読み取れなければ null（**並び順で埋めない**） */
  chapter: number | null;
  /** サブタイトル。分からなければ null */
  title: string | null;
  /** 本文の字数（頭書き・後書きを除く） */
  chars: number;
  /** 合本の中の1話か */
  insideCollected: boolean;
}

export interface WorkScanResult {
  /** 本文の置き場所（`本文/` が無ければ作品フォルダーの直下） */
  bodyDir: string;
  /** 読んだファイルの数（合本は1つと数える） */
  fileCount: number;
  episodes: ScannedEpisode[];
  /** 読めなかったファイル（競合マーカーを含むものもここ） */
  skipped: Array<{ filePath: string; reason: string }>;
}

export function workScan(input: { folder: string }): WorkScanResult {
  const bodyDir = bodyDirOf(input.folder);
  const files = listBodyFiles(input.folder);
  const episodes: ScannedEpisode[] = [];
  const skipped: Array<{ filePath: string; reason: string }> = [];

  for (const relative of files) {
    let text: string;
    try {
      text = readBody(input.folder, relative);
    } catch (error) {
      // **飛ばしたことを数える。** 黙って落とすと、作者には
      // 「その話には何も無かった」と見える
      skipped.push({
        filePath: relative,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // **合本は話ごとに分ける。** 丸ごと1件として返すと、呼ぶ側が
    // 全部を先頭の話数のものとして扱う
    const collected = parseCollectedFile(text);
    if (collected) {
      for (const inner of collected) {
        if (!inner.body.trim()) continue;
        episodes.push({
          filePath: relative,
          chapter: inner.chapter,
          title: inner.title,
          chars: inner.body.length,
          insideCollected: true,
        });
      }
      continue;
    }

    const parsed = parseEpisodeFileName(nodePath.basename(relative));
    const body = parseEpisodeMetadata(text).body;
    if (!body.trim()) continue;
    episodes.push({
      filePath: relative,
      chapter: parsed.chapterStart,
      title: parsed.subtitle,
      chars: body.length,
      insideCollected: false,
    });
  }

  return { bodyDir, fileCount: files.length, episodes, skipped };
}
