import type { CharCounts, EpisodeFile } from "../models/types";
import { emptyCounts, toManuscriptPages } from "./charCount";
import {
  measureKindCounts,
  measureKindText,
  type KindMeasure,
} from "./kindMeasure";
import type { WorkKindKey } from "./workKind";
import {
  episodeTitle,
  formatChapterLabel,
  isCollectedFile,
} from "./episodeLabel";
import type { WorkFormatKey } from "./workFormat";
import { pickCount, type CountMode } from "./countMode";

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
  /**
   * 設定の数え方（純／総）で数えた字数（J1）。**画面に出す・比べるのはこちら。**
   * `net`・`gross` は両方を見せたい所のために残してある
   */
  chars: number;
  /** 原稿用紙の枚数（20字×20行） */
  pages: number;
  /** 基準に対する比。1.0が基準ちょうど（基準は `summary.basis`） */
  ratio: number;
  /** 基準から大きく外れている話の印 */
  flag: "short" | "long" | null;
  /** 1ファイルに複数話が入っている場合の話数 */
  collectedCount: number | null;
  /** 未解決の競合があり、字数を数えていない */
  conflicted: boolean;
  /**
   * 種類の目安（設計書6.109.7。「読了 約2分」「2ページ・3コマ」など）。
   * **小説・競合のある話・中身を読めなかった話は null**
   */
  measure: string | null;
}

export interface EpisodeCountSummary {
  /**
   * 長short・長longの判定に使った基準。
   *
   * **目標を決めていれば目標が基準になる**（設計書6.3.6）。
   * 作者が「1話3,000字」と決めているのに平均と比べても、
   * 全部が短い作品では「どれも平均どおり」としか出ない。
   */
  basis: "goal" | "average";
  /** 基準の字数。`basis` に対応する */
  basisChars: number;
  /** 字数を数えた話数（競合を除く） */
  countedFiles: number;
  /** 競合で数えられなかった話数 */
  conflictedFiles: number;
  /**
   * 平均・中央値・偏りから外した合本の件数。
   *
   * 0でなければ、画面は「合本の◯件は平均に入れていません」と断ること。
   * 数字の出どころを黙って変えない。
   */
  collectedFiles: number;
  /** この一覧を数えた数え方（J1）。画面の列の見出しを合わせるのに使う */
  countMode: EpisodeCountMode;
  /** 設定の数え方で数えた合計・平均・中央値（J1）。画面と三つの輪はこちらを使う */
  totalChars: number;
  averageChars: number;
  medianChars: number;
  /** 純文字数の合計・平均・中央値（数え方の設定にかかわらず純） */
  totalNet: number;
  totalPages: number;
  averageNet: number;
  medianNet: number;
  longest: EpisodeCountRow | null;
  shortest: EpisodeCountRow | null;
  /**
   * 作品ぜんたいの種類の目安（吹き出し向けの1行）。小説では null。
   * 中身を見て数える種類（漫画の原作・歌詞）で、**読めなかった話が
   * 1つでもあれば null**——読めた分だけで出すと、少なく見せてしまう
   */
  totalMeasure: string | null;
  /** 同じ目安の短い形（カードの大きな数字に出す）。小説では null */
  totalMeasureShort: string | null;
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

/**
 * 数え方。選び分けは `core/countMode.ts` の1か所を通す（設定を読む
 * `countSettings.ts` は `vscode` を持つので、ここでは読まない）。
 */
export type EpisodeCountMode = CountMode;

const charsOf = pickCount;

export function buildEpisodeCountTable(
  episodes: EpisodeFile[],
  options: {
    /** SNS記事では「第3話」ではなく「投稿3」と並べる */
    format?: WorkFormatKey;
    /** 1話あたりの目標字数。決めていれば、これが偏りの基準になる */
    perEpisodeGoal?: number | null;
    /** 作品の種類（設計書6.109.7）。小説・未指定なら目安を付けない */
    kind?: WorkKindKey;
    /**
     * 話の本文（場所 → 本文）。**漫画の原作・歌詞のときだけ要る**
     * （ページ・コマ・連は中身を見ないと数えられない）。字数から出せる
     * 台本・エッセイでは渡さなくてよい
     */
    texts?: ReadonlyMap<string, string>;
    /**
     * 数え方（J1、作者の裁定 2026-09-26）。**作品一覧・下の帯と同じ設定を渡す。**
     * 平均比・長短の印・最長最短も、この数え方で比べる——表の数字と印の
     * 数え方が食い違うと、「3,000字なのに短い」のような出方になる。
     * 省略すると純文字数（これまでどおり）
     */
    countMode?: EpisodeCountMode;
  } = {}
): {
  rows: EpisodeCountRow[];
  summary: EpisodeCountSummary;
} {
  const { format, perEpisodeGoal, kind, texts } = options;
  const countMode: EpisodeCountMode = options.countMode ?? "net";
  const counted = episodes.filter((episode) => !episode.hasConflictMarkers);
  const totalNet = counted.reduce((sum, episode) => sum + episode.counts.net, 0);
  const totalChars = counted.reduce(
    (sum, episode) => sum + charsOf(episode.counts, countMode),
    0
  );

  // **合本は平均の母集団に入れない**（設計書6.3）。合本の `net` は中の全話の
  // 合計なので、1行として混ぜると平均が跳ね上がり、普通の話が軒並み
  // 「短い」と判定される（2026-09-12）。合計字数は作品ぜんたいの値なので、
  // そちらからは外さない——「この作品は何字あるか」から中身は消せない
  const population = counted.filter(
    (episode) => !isCollectedFile(episode.collectedCount)
  );
  const averageOf = (pick: (counts: CharCounts) => number): number =>
    population.length > 0
      ? population.reduce((sum, episode) => sum + pick(episode.counts), 0) /
        population.length
      : 0;
  const average = averageOf((counts) => charsOf(counts, countMode));
  const averageNet = averageOf((counts) => counts.net);

  // **目標を決めていれば目標が基準。** 作者が「1話3,000字」と決めているのに
  // 平均と比べても、全部が短い作品では「どれも平均どおり」としか出ない
  const goal = perEpisodeGoal && perEpisodeGoal > 0 ? perEpisodeGoal : null;
  const basis: "goal" | "average" = goal !== null ? "goal" : "average";
  const basisChars = goal ?? average;

  // 目標が基準なら、話数が少なくても印を付けてよい。
  // 平均は少数だと当てにならないが、**目標は1話目から決まっている**。
  // **合本しかない作品では、何も言わない**——比べる相手が1件も無い
  const flagsEnabled =
    basisChars > 0 &&
    population.length > 0 &&
    (goal !== null || population.length >= MIN_FILES_FOR_FLAGS);

  const rows: EpisodeCountRow[] = episodes.map((episode) => {
    const chapterLabel = formatChapterLabel(episode, format);
    const chars = charsOf(episode.counts, countMode);
    const ratio = basisChars > 0 ? chars / basisChars : 0;
    // 合本の行には長短を言わない。中の全話の合計は1話ぶんの長さではない
    const collected = isCollectedFile(episode.collectedCount);
    return {
      filePath: episode.filePath,
      fileName: episode.fileName,
      chapterLabel,
      title: episodeTitle(episode, chapterLabel),
      net: episode.counts.net,
      gross: episode.counts.gross,
      chars,
      pages: toManuscriptPages(episode.counts.manuscriptLines),
      ratio,
      flag:
        episode.hasConflictMarkers || collected || !flagsEnabled
          ? null
          : ratio < SHORT_RATIO
            ? "short"
            : ratio > LONG_RATIO
              ? "long"
              : null,
      collectedCount: collected ? episode.collectedCount : null,
      conflicted: episode.hasConflictMarkers,
      measure: episode.hasConflictMarkers
        ? null
        : (measureEpisode(kind, episode.counts, texts?.get(episode.filePath))
            ?.short ?? null),
    };
  });

  const countedRows = rows.filter((row) => !row.conflicted);
  const totalMeasure = measureTotal(kind, counted, texts);
  // 中央値と「いちばん長い／短い話」も、平均と同じ母集団から出す。
  // 73万字の合本を「いちばん長い話」と呼んでも、作者の役に立たない
  const sorted = countedRows
    .filter((row) => row.collectedCount === null)
    .sort((left, right) => left.chars - right.chars);

  return {
    rows,
    summary: {
      basis,
      basisChars: Math.round(basisChars),
      countedFiles: countedRows.length,
      conflictedFiles: rows.length - countedRows.length,
      collectedFiles: countedRows.length - sorted.length,
      countMode,
      totalChars,
      averageChars: Math.round(average),
      medianChars: median(sorted.map((row) => row.chars)),
      totalNet,
      // 枚数は行数を合算してから換算する。ファイルごとに切り上げると
      // 端数が積み上がって実際より多くなる（設計書6.3.1）
      totalPages: toManuscriptPages(
        counted.reduce((sum, episode) => sum + episode.counts.manuscriptLines, 0)
      ),
      averageNet: Math.round(averageNet),
      // 並びは設定の数え方の順なので、純の中央値は純で並べ直してから取る
      medianNet: median(
        sorted.map((row) => row.net).sort((left, right) => left - right)
      ),
      longest: sorted.length > 0 ? sorted[sorted.length - 1] : null,
      shortest: sorted.length > 0 ? sorted[0] : null,
      totalMeasure: totalMeasure?.detail ?? null,
      totalMeasureShort: totalMeasure?.short ?? null,
    },
  };
}

/** 中身を見ないと数えられない種類（ページ・コマ・連） */
function needsText(kind: WorkKindKey | undefined): boolean {
  return kind === "manga" || kind === "lyrics";
}

/** 1話ぶんの目安。中身の要る種類で本文が無ければ出さない */
function measureEpisode(
  kind: WorkKindKey | undefined,
  counts: CharCounts,
  text: string | undefined
): KindMeasure | undefined {
  if (!kind) return undefined;
  if (needsText(kind)) {
    return text === undefined ? undefined : measureKindText(kind, text, counts);
  }
  return measureKindCounts(kind, counts);
}

/**
 * 作品ぜんたいの目安。
 *
 * **字数を足してから測る。** 話ごとの分数・枚数を足すと、話ごとに
 * 切り上げた端数が積み上がって実際より長くなる（原稿用紙の合算と同じ理由）。
 * 中身を見る種類は、**話を空行で区切って**つないでから数える——
 * つながないと、ある話の最後の連と次の話の最初の連が1連に数えられる。
 */
function measureTotal(
  kind: WorkKindKey | undefined,
  counted: readonly EpisodeFile[],
  texts: ReadonlyMap<string, string> | undefined
): KindMeasure | undefined {
  if (!kind || counted.length === 0) return undefined;
  const total = counted.reduce<CharCounts>(
    (sum, episode) => ({
      net: sum.net + episode.counts.net,
      gross: sum.gross + episode.counts.gross,
      lines: sum.lines + episode.counts.lines,
      paragraphs: sum.paragraphs + episode.counts.paragraphs,
      manuscriptLines: sum.manuscriptLines + episode.counts.manuscriptLines,
    }),
    emptyCounts()
  );
  if (!needsText(kind)) return measureKindCounts(kind, total);
  const bodies: string[] = [];
  for (const episode of counted) {
    const text = texts?.get(episode.filePath);
    if (text === undefined) return undefined;
    bodies.push(text);
  }
  return measureKindText(kind, bodies.join("\n\n"), total);
}

/**
 * 中央値。
 *
 * 平均と併せて出すのは、**極端に長い話・短い話があると平均が動く**ためである。
 * 合本そのものは母集団から外してあるが（上の `population`）、
 * ばらのファイルでも1話だけ長いことはある。
 */
function median(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0;
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle];
  return Math.round((sortedValues[middle - 1] + sortedValues[middle]) / 2);
}
