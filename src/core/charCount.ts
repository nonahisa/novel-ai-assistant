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
  return { gross: 0, net: 0, lines: 0, paragraphs: 0 };
}

/** 集計値を加算する */
export function addCounts(a: CharCounts, b: CharCounts): CharCounts {
  return {
    gross: a.gross + b.gross,
    net: a.net + b.net,
    lines: a.lines + b.lines,
    paragraphs: a.paragraphs + b.paragraphs,
  };
}

/** 3桁区切りで表示する */
export function formatCount(n: number): string {
  return n.toLocaleString("ja-JP");
}

/**
 * 原稿用紙換算（400字詰め）。
 * 小説投稿では分量の目安としてよく使われる。
 */
export function toManuscriptPages(netChars: number): number {
  return Math.ceil(netChars / 400);
}
