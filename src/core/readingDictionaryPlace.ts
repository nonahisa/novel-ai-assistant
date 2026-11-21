import * as path from "./pathText";
import { AIWRITER_DIR, type WorkEntry } from "../models/types";
import { readingDictionaryFileName } from "./readingDictionary";

/**
 * 読みの辞書の置き場の決まり（`.aiwriter/readings/<話>.json`。設計書6.42.1・6.68.2）。
 *
 * **`vscode` を読まない。** 置き場の読み書きは `readingDictionaryStore.ts` が受け持ち、
 * ここは「どのパスに置くか・名前を変えたらどこからどこへ動かすか」だけを決める。
 * モバイル版（novel-ai-mobile）が話の名前を変えたときに同じ決まりで付け替えるため、
 * `vscode` に触れる部分と分けた（2026-11-21）
 */

export const READINGS_DIRECTORY = "readings";

/** その話の、作品フォルダーからの相対パス（`/` 区切り） */
export function episodeRelativePath(work: WorkEntry, episodePath: string): string {
  return path.relative(work.folderPath, episodePath).replace(/\\/g, "/");
}

/** 辞書を並べるフォルダー（`workPaths(work).aiwriter` と同じく作品フォルダー直下の `.aiwriter` の中） */
export function readingDictionaryFolder(work: WorkEntry): string {
  return path.join(work.folderPath, AIWRITER_DIR, READINGS_DIRECTORY);
}

/** その話の辞書の置き場 */
export function readingDictionaryPath(work: WorkEntry, episodePath: string): string {
  return path.join(
    readingDictionaryFolder(work),
    readingDictionaryFileName(episodeRelativePath(work, episodePath))
  );
}

/** 名前を変えたときの辞書の動かし方 */
export interface ReadingDictionaryMove {
  /** 旧い名前の辞書の置き場 */
  from: string;
  /** 新しい名前の辞書の置き場 */
  to: string;
  /** 動かしたあと、辞書の中の `episode` に書く値（新しい話の相対パス） */
  episode: string;
}

/**
 * 話の名前を変えたとき、辞書をどこからどこへ動かすか。
 * **置き場が変わらなければ undefined**（大文字と小文字だけの違いなど、動かす必要が無い）
 */
export function planReadingDictionaryMove(
  work: WorkEntry,
  fromEpisodePath: string,
  toEpisodePath: string
): ReadingDictionaryMove | undefined {
  const from = readingDictionaryPath(work, fromEpisodePath);
  const to = readingDictionaryPath(work, toEpisodePath);
  if (path.normalizeForComparison(from) === path.normalizeForComparison(to)) return undefined;
  return { from, to, episode: episodeRelativePath(work, toEpisodePath) };
}

/** 新しい名前の所に辞書が既にあって、付け替えなかったときの知らせ（どちらにも触れない） */
export function readingDictionaryMoveConflictMessage(
  fromEpisodePath: string,
  toEpisodePath: string
): string {
  return (
    `「${path.basename(toEpisodePath)}」にはもう読みの辞書があるので、` +
    `「${path.basename(fromEpisodePath)}」の辞書を付け替えませんでした（どちらも残しています）。`
  );
}
