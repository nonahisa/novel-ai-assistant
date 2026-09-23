import type { CharCounts } from "../models/types";
import { formatCount, toManuscriptPages } from "./charCount";
import { stripMemoLines } from "./sceneMemo";
import type { WorkKindKey } from "./workKind";

/**
 * 種類ごとの「数え方の目安」（設計書6.109）。
 *
 * 字数はどの種類でも同じに数える（作品一覧・原稿エディタ・執筆量で
 * 同じ数字を出す決まりは変えない）。**ここは字数の横に添える目安だけ**を持つ。
 *
 * | 種類 | 目安 | 根拠 |
 * |---|---|---|
 * | 台本 | 400字詰めの枚数と分数 | シナリオの慣習「400字詰め1枚＝約1分」 |
 * | 漫画の原作 | ページ数・コマ数 | 行頭の ■（ページ）・□（コマ）を数える |
 * | エッセイ・記事 | 読み終えるまでの分数 | 1分＝約500字（日本語の黙読の目安） |
 * | 歌詞・詩 | 連の数・行の数 | 空行と【】の札で区切った塊が1連 |
 * | 小説 | 出さない | これまでどおり（原稿用紙換算は元から出ている） |
 *
 * **目安であって決まりではない。** 台本の枚数は `countManuscriptLines` と
 * 同じ組み方（20字で折り返し、空行も1行）で、柱や人物の頭書きの書式までは
 * 見ない。
 *
 * VS Code APIに依存しない。
 */

export interface KindMeasure {
  /** 字数のすぐ横に添える短い形（例: 「約12分」） */
  short: string;
  /** 吹き出し（ツールチップ）に出す1行 */
  detail: string;
}

/** 台本の1枚（400字詰め）あたりの分数。シナリオの慣習 */
export const SCRIPT_MINUTES_PER_PAGE = 1;
/** エッセイ・記事を1分で読める字数の目安 */
export const ESSAY_CHARS_PER_MINUTE = 500;

/** 漫画の原作のページ（行頭の ■ U+25A0）とコマ（行頭の □ U+25A1） */
const MANGA_PAGE_LINE = /^■/;
const MANGA_PANEL_LINE = /^□/;
/** 歌詞・詩の節の札（行ぜんたいが【…】）。数えない */
const LYRICS_LABEL_LINE = /^\s*【[^【】]*】\s*$/;

/**
 * 字数の集計だけから出せる目安（台本・エッセイ）。
 *
 * 作品ぜんたいの合計（作品一覧の行）はファイルの中身を持っていないので、
 * こちらを使う。漫画の原作・歌詞は中身を見ないと数えられないので出さない。
 */
export function measureKindCounts(
  kind: WorkKindKey | undefined,
  counts: CharCounts
): KindMeasure | undefined {
  if (kind === "script") {
    const pages = toManuscriptPages(counts.manuscriptLines);
    const minutes = pages * SCRIPT_MINUTES_PER_PAGE;
    return {
      short: `約${formatCount(minutes)}分`,
      detail:
        `台本の目安: 400字詰め 約${formatCount(pages)}枚` +
        `（1枚＝約1分として 約${formatCount(minutes)}分）`,
    };
  }
  if (kind === "essay") {
    const minutes = Math.ceil(counts.net / ESSAY_CHARS_PER_MINUTE);
    return {
      short: `読了 約${formatCount(minutes)}分`,
      detail: `読み終えるまでの目安: 約${formatCount(minutes)}分（1分＝約${ESSAY_CHARS_PER_MINUTE}字として）`,
    };
  }
  return undefined;
}

/**
 * 1ファイルぶんの目安。中身を見て数える種類（漫画の原作・歌詞）も出す。
 *
 * @param counts 同じ本文を `countChars` で数えた結果（字数の数え方を
 *   ここで作り直さない——ルビ・メモの扱いが画面の字数と食い違う）
 */
export function measureKindText(
  kind: WorkKindKey | undefined,
  text: string,
  counts: CharCounts
): KindMeasure | undefined {
  if (kind === "manga") {
    const { pages, panels } = countMangaUnits(text);
    return {
      short: `${formatCount(pages)}ページ・${formatCount(panels)}コマ`,
      detail:
        `漫画の原作: ${formatCount(pages)}ページ・${formatCount(panels)}コマ` +
        "（行頭の■をページ、□をコマとして数えています）",
    };
  }
  if (kind === "lyrics") {
    const { stanzas, lines } = countLyricsUnits(text);
    return {
      short: `${formatCount(stanzas)}連・${formatCount(lines)}行`,
      detail:
        `歌詞・詩: ${formatCount(stanzas)}連・${formatCount(lines)}行` +
        "（【】の札と空行で区切った塊を1連として数えています）",
    };
  }
  return measureKindCounts(kind, counts);
}

/** 本文の行（付箋＝シーンメモは落とす。読者へ出す文章ではない） */
function bodyLines(text: string): string[] {
  return stripMemoLines(text).replace(/\r\n?/g, "\n").split("\n");
}

export function countMangaUnits(text: string): { pages: number; panels: number } {
  let pages = 0;
  let panels = 0;
  for (const line of bodyLines(text)) {
    if (MANGA_PAGE_LINE.test(line)) pages++;
    else if (MANGA_PANEL_LINE.test(line)) panels++;
  }
  return { pages, panels };
}

export function countLyricsUnits(text: string): { stanzas: number; lines: number } {
  let stanzas = 0;
  let lines = 0;
  let inStanza = false;
  for (const line of bodyLines(text)) {
    // 空行と札は、どちらも連の切れ目
    if (line.trim() === "" || LYRICS_LABEL_LINE.test(line)) {
      inStanza = false;
      continue;
    }
    lines++;
    if (!inStanza) {
      stanzas++;
      inStanza = true;
    }
  }
  return { stanzas, lines };
}
