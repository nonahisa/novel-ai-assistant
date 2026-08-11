import type { EpisodeFile } from "../models/types";
import { readTextFile } from "./textFile";
import { parseEpisodeMetadata } from "./metadataParser";
import { parseCollectedFile } from "./collectedFile";
import { hashText } from "./textFile";

/**
 * 話ごとの本文を取り出す。
 *
 * 1ファイル1話の作品と、全話が1ファイルに入った合本を、同じ形で扱う。
 * あらすじ生成のように**話を単位にする機能**は、ここを通せば
 * どちらの形の作品でも同じコードで動く。
 */

export interface EpisodeBody {
  /** 元のファイル */
  file: EpisodeFile;
  /** 話数。読み取れなければ null（推測で埋めない） */
  chapter: number | null;
  /** サブタイトル。無ければ null */
  title: string | null;
  body: string;
  /** 本文のハッシュ。作り直しの判断に使う */
  hash: string;
  /**
   * 合本の中の話か。
   *
   * 合本の中の1話は**ファイル名を変えられない**ので、
   * サブタイトルを提案してもリネームできない。
   */
  insideCollected: boolean;
}

export interface EpisodeBodiesResult {
  bodies: EpisodeBody[];
  /** 未解決の競合があって読まなかったファイル */
  conflicted: string[];
}

export async function loadEpisodeBodies(
  episodes: EpisodeFile[]
): Promise<EpisodeBodiesResult> {
  const bodies: EpisodeBody[] = [];
  const conflicted: string[] = [];

  for (const file of episodes) {
    const content = await readTextFile(file.filePath);
    if (content.hasConflictMarkers) {
      // どちらが本文か決められないファイルはAIに渡さない
      conflicted.push(file.fileName);
      continue;
    }

    const collected = parseCollectedFile(content.text);
    if (collected) {
      for (const inner of collected) {
        if (!inner.body.trim()) continue;
        bodies.push({
          file,
          chapter: inner.chapter,
          title: inner.title,
          body: inner.body,
          hash: hashText(inner.body),
          insideCollected: true,
        });
      }
      continue;
    }

    const body = parseEpisodeMetadata(content.text).body;
    if (!body.trim()) continue;
    bodies.push({
      file,
      chapter: file.chapterStart,
      title: file.subtitle ?? file.metaTitle,
      body,
      hash: hashText(body),
      insideCollected: false,
    });
  }

  return { bodies, conflicted };
}

/** AIと画面に出す話の呼び名 */
export function episodeBodyLabel(episode: EpisodeBody): string {
  const chapter =
    episode.chapter !== null
      ? `第${episode.chapter}話`
      : episode.file.fileName;
  return episode.title ? `${chapter} ${episode.title}` : chapter;
}

/**
 * サブタイトルを提案してよい話か。
 *
 * ファイル名が初期状態（数字のみ）で、まだサブタイトルが無いものだけ。
 * 合本の中の話は、ファイル名を変えられないので対象にしない。
 */
export function needsSubtitle(episode: EpisodeBody): boolean {
  if (episode.insideCollected) return false;
  if (!episode.file.isInitialName) return false;
  return !episode.title;
}
