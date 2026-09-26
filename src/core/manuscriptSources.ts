import { WorkEntry } from "../models/types";
import { scanWork } from "./scanner";
import { readTextFile } from "./textFile";
import type { ExcerptSource } from "./mentionExcerpts";
// 1ファイルの割り方は `excerptSourceOf.ts` が持つ（2026-09-26。MCP の束からも使うため）
import { excerptSourcesOfEpisode } from "./excerptSourceOf";
// 出典名の付け方は `episodeLabel.ts` が持つ（0.85.1。MCP の束からも使うため）
export { episodeLabel } from "./episodeLabel";
export { collectedEpisodeLabel } from "./excerptSourceOf";

/**
 * 本文を「出典ラベル付きのテキスト」として読み込む。
 *
 * 掘り下げ・チャットで本文を根拠に答えさせるための材料。
 * 競合マーカーを含むファイルは、どちらが本文か決められないので外す。
 *
 * **シーンメモは抜く**（設計書6.40.2）。ここは用語索引・意味検索・
 * 掘り下げの材料になる唯一の口で、メモの中に書いた人名で場面が引かれると、
 * 「本文に書いてある」という顔で作者のひとりごとが返ってくる。
 * 行数は保つ（`blankMemoLines`）——抜粋の位置を数える処理がずれない。
 */
export async function loadExcerptSources(
  work: WorkEntry
): Promise<{ sources: ExcerptSource[]; conflicted: string[] }> {
  const scan = await scanWork(work);
  const sources: ExcerptSource[] = [];
  const conflicted: string[] = [];

  for (const episode of scan.episodes) {
    const file = await readTextFile(episode.filePath);
    if (file.hasConflictMarkers) {
      conflicted.push(episode.fileName);
      continue;
    }
    sources.push(...excerptSourcesOfEpisode(episode, file.text));
  }

  return { sources, conflicted };
}
