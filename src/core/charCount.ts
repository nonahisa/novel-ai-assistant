import type { CharCounts } from "../models/types";

/**
 * Markdownルビ記法 {漢字|かんじ} からルビ部分を取り除く。
 * ルビは本文の文字数に含めないのが投稿サイトの一般的な扱いのため。
 * 例: "{魔導書庫|まどうしょこ}へ向かう" -> "魔導書庫へ向かう"
 */
export function stripRuby(text: string): string {
  return text.replace(/\{([^{}|]+)\|[^{}|]*\}/g, "$1");
}

/**
 * 文字数を計測する。
 *
 * サロゲートペア（𠮟 など）を1文字として数えるため、
 * String.length ではなく Intl.Segmenter / コードポイント単位で数える。
 */
export function countChars(rawText: string, excludeRuby = true): CharCounts {
  const text = excludeRuby ? stripRuby(rawText) : rawText;

  // 改行コードを LF に統一
  const normalized = text.replace(/\r\n?/g, "\n");

  const lines = normalized.split("\n");

  // 総文字数: 改行を除いた全文字（空白は含む）
  const withoutNewline = normalized.replace(/\n/g, "");
  const gross = countCodePoints(withoutNewline);

  // 純文字数: 空白類（半角・全角スペース、タブ）もすべて除く
  const withoutSpace = withoutNewline.replace(/[\s\u3000]/g, "");
  const net = countCodePoints(withoutSpace);

  // 段落数: 空行で区切られたブロック
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .filter((block) => block.trim().length > 0).length;

  return {
    gross,
    net,
    lines: lines.length,
    paragraphs,
    manuscriptLines: countManuscriptLines(normalized, false),
  };
}

/**
 * コードポイント単位で文字数を数える。
 * 結合文字（濁点の合成など）は分けて数えられるが、
 * 日本語小説での実害は小さいため単純な実装とする。
 */
function countCodePoints(s: string): number {
  let count = 0;
  for (const _ of s) {
    count++;
  }
  return count;
}

/** 空の集計値 */
export function emptyCounts(): CharCounts {
  return { gross: 0, net: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 };
}

/** 集計値を加算する */
export function addCounts(a: CharCounts, b: CharCounts): CharCounts {
  return {
    gross: a.gross + b.gross,
    net: a.net + b.net,
    lines: a.lines + b.lines,
    paragraphs: a.paragraphs + b.paragraphs,
    manuscriptLines: a.manuscriptLines + b.manuscriptLines,
  };
}

/** 3桁区切りで表示する */
export function formatCount(n: number): string {
  return n.toLocaleString("ja-JP");
}

/** 原稿用紙1行あたりの字数 */
export const MANUSCRIPT_COLUMNS = 20;
/** 原稿用紙1枚あたりの行数 */
export const MANUSCRIPT_ROWS = 20;

/**
 * 原稿用紙に書いたときに占める行数を数える。
 *
 * **文字数を400で割っても枚数にはならない。**
 * 1行20字で折り返すため、段落の最終行には余白が残る。
 * たとえば21字の段落は2行を占め、残り19マスは空白になる。
 * 空行も1行として場所を取る。
 * このため実際の枚数は、割り算の結果よりかなり多くなる。
 *
 * 字下げの全角スペースも1マスを使うので、空白を除いた
 * 純文字数ではなく、行ごとの見た目の文字数で数える。
 *
 * 禁則処理（行頭の句読点を前行へ送る等）は考慮していない。
 * 見た目の枚数は組版で前後するため、目安として扱う。
 */
export function countManuscriptLines(rawText: string, excludeRuby = true): number {
  const text = excludeRuby ? stripRuby(rawText) : rawText;
  const normalized = text.replace(/\r\n?/g, "\n");

  let total = 0;
  for (const line of normalized.split("\n")) {
    const width = countCodePoints(line.replace(/\t/g, "    "));
    // 空行も原稿用紙では1行分の場所を取る
    total += width === 0 ? 1 : Math.ceil(width / MANUSCRIPT_COLUMNS);
  }
  return total;
}

/**
 * 原稿用紙の枚数（20字×20行＝400字詰め）。
 *
 * 引数は文字数ではなく行数。文字数から割り算で求めると
 * 折り返しの余白を数え落とすため（countManuscriptLines を参照）。
 */
export function toManuscriptPages(manuscriptLines: number): number {
  return Math.ceil(manuscriptLines / MANUSCRIPT_ROWS);
}
