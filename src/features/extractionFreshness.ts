import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { SETTINGS_DIRECTORY_NAMES } from "../core/externalChanges";
import { scanWork } from "../core/scanner";
import {
  countUnextracted,
  shouldOfferExtraction,
  type EpisodeTimestamp,
} from "../core/extractionFreshness";

/**
 * まだ設定資料へ取り込んでいない話を数える（設計書6.21.1）。
 *
 * AIの独り言が「空き時間に資料抽出やっておきましょうか？」と申し出る材料。
 *
 * **更新時刻だけを見る。** 中身で比べるには全話をチャンクへ割ることになり、
 * 独り言のために払う費用としては大きすぎる。
 */
export async function countUnextractedEpisodes(
  work: WorkEntry
): Promise<number | undefined> {
  const settingsAt = await newestSettingsTime(work);
  // **一度も抽出していない作品では、数を出さない。**
  // 登録した直後に「19話ぶん抽出しませんか」は催促である
  if (settingsAt === undefined) return undefined;

  let episodes: EpisodeTimestamp[];
  try {
    const scanned = await scanWork(work);
    episodes = await Promise.all(
      scanned.episodes.map(async (episode) => ({
        filePath: episode.filePath,
        modifiedAt: await modifiedAt(episode.filePath),
      }))
    );
  } catch {
    // 走査できないのは、まだ何も無いか読めないだけ。黙る
    return undefined;
  }

  const freshness = countUnextracted(episodes, settingsAt);
  // **1話だけでは申し出ない。** 書いた直後に毎回言われると催促になる
  return shouldOfferExtraction(freshness) ? freshness.unextracted : 0;
}

/**
 * 設定資料がいちばん新しく書かれた時刻。
 *
 * 一度も抽出していなければ undefined。**「0」ではない。**
 */
async function newestSettingsTime(
  work: WorkEntry
): Promise<number | undefined> {
  const config = await readWorkConfig(work).catch(() => undefined);
  const root = workPaths(work, config).settings;

  let newest: number | undefined;
  for (const name of SETTINGS_DIRECTORY_NAMES) {
    const directory = path.join(root, name);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        path.toUri(directory)
      );
    } catch {
      // そのフォルダがまだ無い作品もある
      continue;
    }
    for (const [fileName, kind] of entries) {
      if (kind !== vscode.FileType.File) continue;
      if (!fileName.toLowerCase().endsWith(".json")) continue;
      const at = await modifiedAt(path.join(directory, fileName));
      if (at !== undefined && (newest === undefined || at > newest)) {
        newest = at;
      }
    }
  }
  return newest;
}

async function modifiedAt(filePath: string): Promise<number | undefined> {
  try {
    return (await vscode.workspace.fs.stat(path.toUri(filePath))).mtime;
  } catch {
    return undefined;
  }
}
