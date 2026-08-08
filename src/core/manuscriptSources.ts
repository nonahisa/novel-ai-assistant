import { WorkEntry } from "../models/types";
import type { EpisodeFile } from "../models/types";
import { scanWork } from "./scanner";
import { readTextFile } from "./textFile";
import { parseEpisodeMetadata } from "./metadataParser";
import type { ExcerptSource } from "./mentionExcerpts";

/**
 * 本文を「出典ラベル付きのテキスト」として読み込む。
 *
 * 掘り下げ・チャットで本文を根拠に答えさせるための材料。
 * 競合マーカーを含むファイルは、どちらが本文か決められないので外す。
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
    const body = parseEpisodeMetadata(file.text).body;
    if (!body.trim()) continue;
    sources.push({ label: episodeLabel(episode), text: body });
  }

  return { sources, conflicted };
}

/**
 * AIに示す出典名。
 *
 * 「第12話 再会」のように話数とサブタイトルを出す。
 * 話数が判定できないファイルはファイル名で示す。
 */
export function episodeLabel(episode: EpisodeFile): string {
  const title = episode.metaTitle ?? episode.subtitle;
  const chapter = chapterPart(episode);
  if (chapter && title) return `${chapter} ${title}`;
  if (chapter) return chapter;
  if (title) return `${episode.fileName}（${title}）`;
  return episode.fileName;
}

function chapterPart(episode: EpisodeFile): string {
  if (episode.kind !== "本編" && episode.kind !== "不明") {
    return episode.chapterStart !== null
      ? `${episode.kind}${episode.chapterStart}`
      : episode.kind;
  }
  if (episode.chapterStart === null) return "";
  if (
    episode.chapterEnd !== null &&
    episode.chapterEnd !== episode.chapterStart
  ) {
    return `第${episode.chapterStart}〜${episode.chapterEnd}話`;
  }
  return `第${episode.chapterStart}話`;
}
