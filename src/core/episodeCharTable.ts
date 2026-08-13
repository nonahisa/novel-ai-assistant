import type { EpisodeFile } from "../models/types";
import { toManuscriptPages } from "./charCount";
import { episodeTitle, formatChapterLabel } from "./episodeLabel";

/**
 * 話ごとの文字数一覧（設計書6.3）。
 *
 * 作品一覧にも1話ずつの字数は出ているが、**縦に並べただけでは
 * 長さの偏りが読み取れない。** 極端に短い話・長い話は、投稿の間隔や
 * 読者の離脱に効く。平均と比べた形で見せる。
 */

/** 一覧の1行 */
export interface EpisodeCountRow {
  /** 行の識別子。ファイルパスをそのまま使う */
  filePath: string;
  fileName: string;
  /** 「第3話」など。読み取れなければ空 */
  chapterLabel: string;
  /** サブタイトル。無ければ null */
  title: string | null;
  net: number;
  gross: number;
  /** 原稿用紙の枚数（20字×20行） */
  pages: number;
  /** 平均に対する比。1.0が平均ちょうど */
  ratio: number;
  /** 平均から大きく外れている話の印 */
  flag: "short" | "long" | null;
  /** 1ファイルに複数話が入っている場合の話数 */
  collectedCount: number | null;
  /** 未解決の競合があり、字数を数えていない */
  conflicted: boolean;
}

export interface EpisodeCountSummary {
  /** 字数を数えた話数（競合を除く） */
  countedFiles: number;
  /** 競合で数えられなかった話数 */
  conflictedFiles: number;
  totalNet: number;
  totalPages: number;
  averageNet: number;
  medianNet: number;
  longest: EpisodeCountRow | null;
  shortest: EpisodeCountRow | null;
}

/**
 * 偏りの印を付ける境目。
 *
 * 平均の半分・2倍を目安にする。作品によって1話の長さの基準は違うので、
 * 固定の字数（3000字未満は短い、など）では役に立たない。
 */
export const SHORT_RATIO = 0.5;
export const LONG_RATIO = 2.0;

/**
 * 印を付け始めるのに必要な話数。
 *
 * 2話しかない作品では、片方が必ず「平均より上」になる。
 * 数が少ないうちは平均そのものが当てにならないので何も言わない。
 */
export const MIN_FILES_FOR_FLAGS = 4;

export function buildEpisodeCountTable(episodes: EpisodeFile[]): {
  rows: EpisodeCountRow[];
  summary: EpisodeCountSummary;
} {
  const counted = episodes.filter((episode) => !episode.hasConflictMarkers);
  const totalNet = counted.reduce((sum, episode) => sum + episode.counts.net, 0);
  const average = counted.length > 0 ? totalNet / counted.length : 0;
  const flagsEnabled = counted.length >= MIN_FILES_FOR_FLAGS && average > 0;

  const rows: EpisodeCountRow[] = episodes.map((episode) => {
    const chapterLabel = formatChapterLabel(episode);
    const ratio = average > 0 ? episode.counts.net / average : 0;
    return {
      filePath: episode.filePath,
      fileName: episode.fileName,
      chapterLabel,
      title: episodeTitle(episode, chapterLabel),
      net: episode.counts.net,
      gross: episode.counts.gross,
      pages: toManuscriptPages(episode.counts.manuscriptLines),
      ratio,
      flag:
        episode.hasConflictMarkers || !flagsEnabled
          ? null
          : ratio < SHORT_RATIO
            ? "short"
            : ratio > LONG_RATIO
              ? "long"
              : null,
      collectedCount: episode.collectedCount,
      conflicted: episode.hasConflictMarkers,
    };
  });

  const countedRows = rows.filter((row) => !row.conflicted);
  const sorted = [...countedRows].sort((left, right) => left.net - right.net);

  return {
    rows,
    summary: {
      countedFiles: countedRows.length,
      conflictedFiles: rows.length - countedRows.length,
      totalNet,
      // 枚数は行数を合算してから換算する。ファイルごとに切り上げると
      // 端数が積み上がって実際より多くなる（設計書6.3.1）
      totalPages: toManuscriptPages(
        counted.reduce((sum, episode) => sum + episode.counts.manuscriptLines, 0)
      ),
      averageNet: Math.round(average),
      medianNet: median(sorted.map((row) => row.net)),
      longest: sorted.length > 0 ? sorted[sorted.length - 1] : null,
      shortest: sorted.length > 0 ? sorted[0] : null,
    },
  };
}

/**
 * 中央値。
 *
 * 平均と併せて出すのは、**1つの長い合本ファイルがあると平均が跳ね上がる**
 * ためである。19話のうち1話だけ73万字なら、平均は誰の実感とも合わない。
 */
function median(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0;
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle];
  return Math.round((sortedValues[middle - 1] + sortedValues[middle]) / 2);
}
