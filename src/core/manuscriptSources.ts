import { WorkEntry } from "../models/types";
import type { EpisodeFile } from "../models/types";
import { scanWork } from "./scanner";
import { readTextFile } from "./textFile";
import { parseEpisodeMetadata } from "./metadataParser";
import { parseCollectedFile, type CollectedEpisode } from "./collectedFile";
import { blankMemoLines } from "./sceneMemo";
import type { ExcerptSource } from "./mentionExcerpts";

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
    // 合本は話ごとの出典にする。1つの塊にすると
    // 「どの話に書いてあったか」を示せない
    const collected = parseCollectedFile(file.text);
    if (collected) {
      for (const inner of collected) {
        const body = blankMemoLines(inner.body);
        if (!body.trim()) continue;
        sources.push({
          label: collectedEpisodeLabel(episode, inner),
          text: body,
        });
      }
      continue;
    }

    const body = blankMemoLines(parseEpisodeMetadata(file.text).body);
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

/**
 * 合本の中の1話の出典名。
 *
 * 話数が読み取れなければファイル内の並び順で示す。
 * **並び順を話数として出さない**（「プロローグ」を第1話と呼んでしまうため）。
 */
export function collectedEpisodeLabel(
  file: EpisodeFile,
  inner: CollectedEpisode
): string {
  const chapter =
    inner.chapter !== null ? `第${inner.chapter}話` : `${file.fileName}の${inner.order}番目`;
  return inner.title ? `${chapter} ${inner.title}` : chapter;
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
