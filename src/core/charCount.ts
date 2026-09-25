import type { CharCounts } from "../models/types";
import { stripMemoLines } from "./sceneMemo";
// **記法の定義は `core/ruby.ts` の1つだけにする**（設計書6.2）。
// ここに同じ名前の写しがあり、そちらは傍点 `{{強調}}` を知らなかったため、
// 印の4字（`{{` と `}}`）が本文として数えられていた（2026-09-08に実機で判明。
// 傍点を1つ入れるたびに作品の字数が4字ずつ増えていた）。
// **`ruby.ts` は何も import していない**ので、循環にはならない
import { stripRuby } from "./ruby";
import { breakIntoLines, unitsOfText, type GridOptions } from "./manuscriptGrid";

// 既存の呼び出し口（`charCount` から取っていた側）を保つための再輸出。
// **写しではなく、`ruby.ts` の実体そのものを渡す**
export { stripRuby };

/**
 * 文字数を計測する。
 *
 * サロゲートペア（𠮟 など）を1文字として数えるため、
 * String.length ではなく Intl.Segmenter / コードポイント単位で数える。
 */
export function countChars(rawText: string, excludeRuby = true): CharCounts {
  // **シーンメモは執筆量ではない**（設計書6.40.2）。作者の付箋であって
  // 読者へ出す文章ではないので、行ごと落としてから数える
  const withoutMemo = stripMemoLines(rawText);
  const text = excludeRuby ? stripRuby(withoutMemo) : withoutMemo;

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
 * **20マスを超える行は、公募の納品用の組み方で割る**（2026-09-26 精査 R9。
 * 設計書6.3.1）。PDF の「公募の納品用」（`manuscriptGrid.ts`）と同じ
 * `breakIntoLines` を、20字・縦書き・句読点のぶら下げありで通す。
 * 割り算だけだと、行頭に来る句読点（ぶら下げて1行に収まる）・閉じ括弧
 * （前の字ごと送って行が増える）・縦中横の半角数字（2字で1マス）を
 * 数え違える。行の数え方の約束（空行も1行・メモは数えない・ルビの扱い）は
 * 今までのまま。縦書きにするのは、原稿用紙が縦書きの紙だから。
 */
export function countManuscriptLines(rawText: string, excludeRuby = true): number {
  // メモの行は原稿用紙のマスを取らない（設計書6.40.2）。
  // `countChars` から呼ばれるときは既に落ちているが、**外から直に
  // 呼ばれる道がある**ので、ここでも落とす（掛け直しても結果は変わらない）
  const withoutMemo = stripMemoLines(rawText);
  const text = excludeRuby ? stripRuby(withoutMemo) : withoutMemo;
  const normalized = text.replace(/\r\n?/g, "\n");

  let total = 0;
  for (const raw of normalized.split("\n")) {
    const line = raw.replace(/\t/g, "    ");
    const width = countCodePoints(line);
    // 空行も原稿用紙では1行分の場所を取る
    if (width === 0) {
      total += 1;
      continue;
    }
    // 20字以内の行は、どう組んでも1行（縦中横は字を減らす向きにしか効かない）。
    // 保存のたびに作品全体を数えるので、組み方を通すのは溢れる行だけにする
    if (width <= MANUSCRIPT_COLUMNS) {
      total += 1;
      continue;
    }
    // 記法はここへ来る前に外すか、外さない設定なら字として数える約束なので、
    // 記法を読む `unitsOfLine` ではなく素の字として部品にする
    total += breakIntoLines(unitsOfText(line, true, false), MANUSCRIPT_GRID).length;
  }
  return total;
}

/** 原稿用紙の組み方（20字・縦書き・句読点はぶら下げる） */
const MANUSCRIPT_GRID: GridOptions = {
  columns: MANUSCRIPT_COLUMNS,
  rows: MANUSCRIPT_ROWS,
  hanging: true,
  vertical: true,
};

/**
 * 原稿用紙の枚数（20字×20行＝400字詰め）。
 *
 * 引数は文字数ではなく行数。文字数から割り算で求めると
 * 折り返しの余白を数え落とすため（countManuscriptLines を参照）。
 */
export function toManuscriptPages(manuscriptLines: number): number {
  return Math.ceil(manuscriptLines / MANUSCRIPT_ROWS);
}
