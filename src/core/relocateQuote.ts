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
 * 引用の前後にあった本文（設計書6.96.3）。
 *
 * **数日残す指摘のために足した。** `hintLine` は検知した日の行番号なので、
 * 三日ぶん書き足されたあとでは手がかりとして弱くなる——「近いほう」で
 * 選ぶと、**遠くの正しい一致より、近くの別の一致**を採ってしまう。
 * 前後の本文は本文が動いても一緒に動くので、そこで先に絞る。
 *
 * どちらか片方だけでもよい（ファイルの先頭・末尾の指摘には片方しか無い）。
 */
export interface QuoteContext {
  /** 引用の直前にあった本文。**いちばん近い1行**だけを見る */
  before?: string;
  /** 引用の直後にあった本文。**いちばん近い1行**だけを見る */
  after?: string;
}

/**
 * 引用が在る行を返す（**1始まり**）。見つからなければ `undefined`。
 *
 * @param text 改行で分けられる本文（CRLF でも CR でもよい）
 * @param quote 本文に実在するはずの引用（`original` / `excerpt`）
 * @param hintLine 検知したときの行番号。候補が複数あるときの手がかり
 * @param context 検知したときの前後の本文。**候補が複数のときだけ効く**
 */
export function relocateQuote(
  text: string,
  quote: string,
  hintLine: number,
  context?: QuoteContext
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
    **前後の本文で先に絞る。** 絞った結果が空になったら絞らない
    ——文脈のほうが古びていることもあるので、「文脈が合わないから
    見つからなかった」ことにはしない（見つかった位置が正しいかどうかは
    呼び出し側が原文で検算している）。
  */
  const narrowed = narrowByContext(lines, hits, context);

  /*
    **同じ引用が2か所にあるときは、`hintLine` にいちばん近いほうを選ぶ。**
    1件当てたくらいで行が大きく動くことはないので、近さが最も確かな
    手がかりになる。

    上下に同じだけ離れていたときは**前（行番号の小さいほう）**を返す。
    どちらが正しいかは決められないが、決め方を固定しないと押すたびに
    飛び先が変わりかねない。前を選ぶのは、行を頭から走査して最初に
    当たったものを採る形で、`proposalUndo.ts` の「最初の一致」と揃う。
  */
  return narrowed.reduce((best, line) =>
    Math.abs(line - hintLine) < Math.abs(best - hintLine) ? line : best
  );
}

/**
 * 候補を、前後の本文が合うものだけに絞る。
 *
 * **合う数が多いものを採る**（前も後ろも合う > 片方だけ合う > どちらも
 * 合わない）。前だけ／後ろだけしか持っていない指摘があるので、
 * 「両方合うこと」を条件にすると何も残らない。
 *
 * 空行は飛ばして**中身のある隣の行**と比べる。原稿は段落の間に空行を
 * 挟む形なので、隣をそのまま見ると空文字どうしの比較になって
 * どの候補でも合ってしまう。
 */
function narrowByContext(
  lines: string[],
  hits: number[],
  context: QuoteContext | undefined
): number[] {
  const before = lastMeaningfulLine(context?.before ?? "");
  const after = firstMeaningfulLine(context?.after ?? "");
  if (!before && !after) return hits;

  let bestScore = 0;
  let best: number[] = [];
  for (const line of hits) {
    let score = 0;
    if (before && matchesNeighbor(lines, line - 1, -1, before)) score += 1;
    if (after && matchesNeighbor(lines, line - 1, +1, after)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = [line];
    } else if (score === bestScore && score > 0) {
      best.push(line);
    }
  }
  // どの候補も文脈に合わなければ、絞らずに全部返す（近さで決める）
  return best.length > 0 ? best : hits;
}

/**
 * `index`（0始まり）から `step` の向きへ進み、**最初に中身のある行**が
 * 手がかりと重なるか。
 *
 * 片方がもう片方を含んでいれば合ったとみなす——前後の本文は保存のときに
 * 切り詰めることがあり、完全一致を求めると切り詰めた側が必ず外れる。
 * ただし**短すぎる断片では含みを見ない**（「。」だけの行はどこにでも
 * 含まれてしまい、絞ったつもりで絞れていない形になる）。
 */
const CONTEXT_MIN_CHARS = 4;

function matchesNeighbor(
  lines: string[],
  index: number,
  step: number,
  needle: string
): boolean {
  for (let at = index + step; at >= 0 && at < lines.length; at += step) {
    const normalized = normalizeForComparison(lines[at]);
    if (normalized.length === 0) continue;
    if (normalized === needle) return true;
    if (needle.length >= CONTEXT_MIN_CHARS && normalized.includes(needle)) {
      return true;
    }
    return (
      normalized.length >= CONTEXT_MIN_CHARS && needle.includes(normalized)
    );
  }
  return false;
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

/**
 * 「前の本文」のうち、引用にいちばん近い行（正規化済み）。
 *
 * 前の本文は複数行を持てるが、引用に接しているのは**最後の行**である。
 */
function lastMeaningfulLine(quote: string): string | undefined {
  const lines = quote.split(/\r\n|\r|\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeForComparison(lines[index]);
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}
