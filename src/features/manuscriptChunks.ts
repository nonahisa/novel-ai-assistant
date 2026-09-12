// ログの書き先：呼ぶ側が向ける
// 本文を割る共通の口で、**どの検知のための割り方かはここには届かない**
// （呼ぶのは矛盾検知と、事実の照合による矛盾検知）。呼ぶ側が
// useLogFile で作品のログへ向けてから使う。
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { ModelInfo } from "../ai/types";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { mergeAdjacentChunks, type Chunk } from "../core/chunker";
import { chunksOfEpisodeFile } from "../core/episodeChunks";
import { formatChapterLabel } from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import { logFailure } from "../core/logger";
import {
  describeChunkSettings,
  readChunkSettings,
  type ChunkFixedCost,
} from "./chunkSettings";

/**
 * 本文をチャンクに割る、機能どうしで共通の手順（設計書6.23）。
 *
 * **写しを作らない。** 矛盾検知（P-12）と、事実の照合による矛盾検知
 * （6.88の第4段）は同じ割り方をする必要がある——別々に書くと、
 * 同じ本文が別の切れ目で切られ、**両方の結果を見比べる**という
 * 並行運用（6.88.9）の前提が崩れる。
 */

export interface ManuscriptChunkOptions {
  /** 話を絞る。指定しなければ作品全体 */
  filePaths?: string[];
}

export interface ManuscriptChunks {
  chunks: Chunk[];
  /** ファイルの場所 → 見出し（「第3話」など） */
  chapterLabelByFile: Map<string, string>;
  /**
   * ファイルの場所 → 話数。読めなければ null。
   *
   * **いまは退避先である。** 話数はチャンクの内訳（`ChunkSegment`）が
   * 持っており、位置から引くのが正しい（`chunker.ts` の `segmentAtLine`）。
   * これはファイル単位なので、**合本では先頭の話数しか返せない**
   * ——内訳を持たないチャンクに当たったときの最後の頼みとして残す。
   */
  chapterByFile: Map<string, number | null>;
  /** 何を根拠に大きさを決めたか。ログに残す（設計書6.23） */
  chunkNote: string;
  /**
   * 読めなかった話の数。
   *
   * **黙って落とさない。** その話だけ検知の対象から抜けるのに、
   * 作者には「その話には何も無い」と見える。
   */
  unreadableEpisodes: number;
}

export async function collectManuscriptChunks(params: {
  work: WorkEntry;
  /** 呼び出し側が引いたモデル情報。**ここでは引き直さない** */
  info: ModelInfo;
  options: ManuscriptChunkOptions;
  fixedCost: ChunkFixedCost;
  /** 未チューニングの安全既定・書ける量の絞り込み用（設計書6.65.16） */
  outputTuning: { providerId: string; model: string };
  /**
   * 失敗をログへ残すときの名前（「矛盾検知」など）。
   *
   * **決め打ちにしない。** 呼び出し側が増えたときに、動かしている機能と
   * 違う名前がログへ出ると、原因を追う側が別の機能を疑う。
   */
  logLabel: string;
}): Promise<ManuscriptChunks> {
  const { work, info, options, fixedCost, outputTuning, logLabel } = params;
  const scan = await scanWork(work);
  const format = await readWorkFormat(work);
  const targets = options.filePaths
    ? scan.episodes.filter((episode) =>
        options.filePaths!.some(
          (filePath) =>
            path.resolve(filePath).toLowerCase() ===
            path.resolve(episode.filePath).toLowerCase()
        )
      )
    : scan.episodes;

  // **固定費を差し引いてから本文の割当を決める**（設計書6.27.10）。
  // コンテキスト長が取れないときは、ここまで来ない
  // （`resolveModelInfoOrWarn` が理由を出して止めている）
  const chunkSettings = readChunkSettings(
    info.contextWindow,
    fixedCost,
    outputTuning
  );
  const maxChars = chunkSettings.chunk.chars;

  const chunks: Chunk[] = [];
  const chapterLabelByFile = new Map<string, string>();
  const chapterByFile = new Map<string, number | null>();
  let unreadableEpisodes = 0;

  for (const episode of targets) {
    if (episode.hasConflictMarkers) continue;
    let text: string;
    try {
      text = (await readTextFile(episode.filePath)).text;
    } catch (error) {
      // **記録して数える。** 黙って落とすと、その話は検知の対象から
      // 抜けたのに、作者には「何も無かった」と見える
      unreadableEpisodes++;
      logFailure(`${logLabel}：本文の読み込み`, {
        ファイル: episode.filePath,
        詳細: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const label = formatChapterLabel(episode, format) || episode.fileName;
    // **合本は話ごとに切る**（`core/episodeChunks.ts`）。丸ごと切ると
    // 全チャンクの話数が先頭の話数になり、矛盾の指摘が全部「第1話」になる
    for (const chunk of chunksOfEpisodeFile(episode.filePath, text, episode, {
      maxChars,
      mergeChars: chunkSettings.mergeChars,
    })) {
      chunks.push(chunk);
    }
    chapterLabelByFile.set(episode.filePath, label);
    chapterByFile.set(episode.filePath, episode.chapterStart);
  }

  // **1話ずつ送ると、指示のほうが本文より大きい**（設計書6.23）。
  // 隣どうしをまとめて呼び出し回数を減らす。返ってきた行番号は
  // `locateChunkLine` で元のファイルへ戻す
  const merged =
    chunkSettings.mergeChars > 0
      ? mergeAdjacentChunks(chunks, { maxChars: chunkSettings.mergeChars })
      : chunks;

  return {
    chunks: merged,
    chapterLabelByFile,
    chapterByFile,
    chunkNote: describeChunkSettings(chunkSettings),
    unreadableEpisodes,
  };
}
