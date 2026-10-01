import type { EpisodeFile } from "../models/types";
import { readTextFile } from "./textFile";
import { splitEpisodeBodyParts } from "./episodeBodyParts";

/**
 * 話ごとの本文を取り出す。
 *
 * 1ファイル1話の作品と、全話が1ファイルに入った合本を、同じ形で扱う。
 * あらすじ生成のように**話を単位にする機能**は、ここを通せば
 * どちらの形の作品でも同じコードで動く。
 *
 * ## シーンメモは、ここで消す（設計書6.40.2）
 *
 * **ここを通るのは、すべてAIへ渡す経路である**（各話あらすじ・紹介文・
 * プロット逆算・書き出しの点検）。チャンクを作らずに本文をまるごと送るので、
 * `splitIntoChunks` の側の始末が効かない。**行数は保つ**（`blankMemoLines`）
 * ——引用の位置をAIに言わせる機能が増えたときに、行番号がずれない。
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

    // 話ごとに分ける・メモを消す・ハッシュを取るのは `episodeBodyParts.ts`
    // （外部AIのあらすじを保存する道と同じものを通す。2026-10-02）
    for (const part of splitEpisodeBodyParts(content.text, {
      chapter: file.chapterStart,
      title: file.subtitle ?? file.metaTitle,
    })) {
      bodies.push({ file, ...part });
    }
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
