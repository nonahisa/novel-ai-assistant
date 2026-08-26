import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { readExtractedIndex } from "../core/extractedIndexStore";
import {
  countUnextracted,
  shouldOfferExtraction,
  type EpisodeContent,
} from "../core/extractedIndex";

/**
 * まだ設定資料へ取り込んでいない話を数える（設計書6.21.3）。
 *
 * AIの独り言が「空き時間に資料抽出やっておきましょうか？」と申し出る材料。
 *
 * **中身のハッシュで比べる。** 以前は更新時刻で比べていたが、gitは
 * 更新時刻を保存しないため、**取り込み（pull）のたびに全話が「未抽出」に
 * なっていた**（作者の指摘、2026-08-24）。理由は `core/extractedIndex.ts`。
 */
export async function countUnextractedEpisodes(
  work: WorkEntry
): Promise<number | undefined> {
  // **記録が無い＝一度も抽出していない。** 数を出さない
  const index = await readExtractedIndex(work);
  if (!index || Object.keys(index.files).length === 0) return undefined;

  let episodes: EpisodeContent[];
  try {
    const scanned = await scanWork(work);
    episodes = await Promise.all(
      scanned.episodes.map(async (episode) => ({
        relativePath: toRelative(work, episode.filePath),
        text: await readIfPossible(episode.filePath),
      }))
    );
  } catch {
    // 走査できないのは、まだ何も無いか読めないだけ。黙る
    return undefined;
  }

  const freshness = countUnextracted(episodes, index);
  // **1話だけでは申し出ない。** 書いた直後に毎回言われると催促になる
  return shouldOfferExtraction(freshness) ? freshness.unextracted : 0;
}

/**
 * 記録に使う、作品フォルダーからの相対パス。
 *
 * **絶対パスで持たない。** 作品を別の場所へ写したり、別のPCで開いたり
 * すると、同じ話が別物になってしまう。区切りは `/` に揃える
 * （Windowsとそれ以外で記録が食い違わないように）。
 */
export function toRelative(work: WorkEntry, filePath: string): string {
  return path.relative(work.folderPath, filePath).replace(/\\/g, "/");
}

/** 抽出のあとに書き留めるための、いまの中身 */
export async function readEpisodeContents(
  work: WorkEntry
): Promise<EpisodeContent[]> {
  const scanned = await scanWork(work);
  return Promise.all(
    scanned.episodes.map(async (episode) => ({
      relativePath: toRelative(work, episode.filePath),
      text: await readIfPossible(episode.filePath),
    }))
  );
}

async function readIfPossible(filePath: string): Promise<string | undefined> {
  try {
    return (await readTextFile(filePath)).text;
  } catch {
    return undefined;
  }
}
