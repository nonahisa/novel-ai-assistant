import { normalizeForComparison } from "./groundedEvidence";

/**
 * 引用が、いまの本文の何行目に在るかを探し直す（設計書6.11）。
 *
 * ## なぜ要るか
 *
 * 指摘が持っている `line` は**検知したときの行番号**である。推敲は原文を
 * まるごと修正案へ置き換えるので、1件当てるだけで行の数が変わることがある
 * （複数行にまたがる「語尾単調」など）。一覧に残っている指摘は古い行番号を
 * 抱えたままなので、そこから先の「本文を見る」が全部ずれる
 * （作者の報告、2026-09-12）。
 *
 * 行番号は当てた瞬間に古くなるが、**引用は本文に在るかぎり古くならない。**
 * そこで飛ぶ直前に引用のほうから行を決め直す。
 *
 * ## 一覧の `line` は書き換えない
 *
 * 直すのは「飛び先」だけである。一覧側の `line` を書き換えると、無視の記録の
 * 鍵（`dismissKey`）が動いて、見送ったはずの指摘がまた出てくる。
 */

/**
 * 引用が在る行を返す（**1始まり**）。見つからなければ `undefined`。
 *
 * @param text 改行で分けられる本文（CRLF でも CR でもよい）
 * @param quote 本文に実在するはずの引用（`original` / `excerpt`）
 * @param hintLine 検知したときの行番号。候補が複数あるときの手がかり
 */
export function relocateQuote(
  text: string,
  quote: string,
  hintLine: number
): number | undefined {
  const needle = firstMeaningfulLine(quote);
  if (!needle) return undefined;

  const lines = text.split(/\r\n|\r|\n/u);
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (normalizeForComparison(lines[index]).includes(needle)) {
      hits.push(index + 1);
    }
  }
  if (hits.length === 0) return undefined;

  /*
    **同じ引用が2か所にあるときは、`hintLine` にいちばん近いほうを選ぶ。**
    1件当てたくらいで行が大きく動くことはないので、近さが最も確かな
    手がかりになる。

    上下に同じだけ離れていたときは**前（行番号の小さいほう）**を返す。
    どちらが正しいかは決められないが、決め方を固定しないと押すたびに
    飛び先が変わりかねない。前を選ぶのは、行を頭から走査して最初に
    当たったものを採る形で、`proposalUndo.ts` の「最初の一致」と揃う。
  */
  return hits.reduce((best, line) =>
    Math.abs(line - hintLine) < Math.abs(best - hintLine) ? line : best
  );
}

/**
 * 引用のうち、1行に収まって探せる部分を取り出す（正規化済み）。
 *
 * 引用が複数行にまたがるときは**最初の行だけ**で探す。本文を行で割って
 * 探すので、改行をまたぐ引用はどの行にも丸ごとは収まらない。
 *
 * 先頭が空行のこともある（引用が改行から始まる）ので、**中身のある最初の行**
 * まで進める。全部が空白なら、どの行にも「在る」ことになってしまうので
 * 手を出さない。
 */
function firstMeaningfulLine(quote: string): string | undefined {
  for (const line of quote.split(/\r\n|\r|\n/u)) {
    const normalized = normalizeForComparison(line);
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}
