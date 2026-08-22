/**
 * 設定資料の読み仮名を、本文のルビとして振る（設計書6.12.5）。
 *
 * 作者の指示（2026-08-23）：設定資料のパネルに「ルビを追加」を置き、
 * すべての話／開いている話／選んだ話、から対象を選べるようにする。
 *
 * ## 読み仮名を持つ名前だけを扱う
 *
 * 別名（呼び方）には読み仮名が無い。**読みの分からないものにルビは振れない**
 * ので、`name` と `reading` がそろっているレコードだけを対象にする。
 * 姓名を分けた呼び方（「マルキオ・イークェス」に対する「マルキオ」）も
 * 広げない——**その部分だけの読みは、こちらには分からない。**
 *
 * ## すでにルビのあるところへは振らない
 *
 * `{漢字|かんじ}` の中や、投稿サイト記法 `｜漢字《かんじ》` の中に
 * もう一度ルビを振ると、**二重になって本文が壊れる。**
 *
 * VS Code APIに依存しない。
 */

export interface RubyTerm {
  /** 本文に現れる文字列（レコードの正式名称） */
  text: string;
  /** 振る読み仮名 */
  reading: string;
}

/** どこまで振るか */
export type RubyScope =
  /** その話で最初に出てきた1回だけ（投稿作品でよくある形） */
  | "first"
  /** 出てくるところすべて */
  | "all";

export interface RubyInsertion {
  start: number;
  end: number;
  term: RubyTerm;
}

/**
 * すでにルビや傍点になっているところ。ここへは振らない。
 *
 * - `{漢字|かんじ}` … この拡張機能の書き方
 * - `{{強調}}` … 傍点
 * - `｜漢字《かんじ》` / `漢字《かんじ》` … 投稿サイトの書き方
 * - `#漢字__かんじ__#` … アルファポリスのもう1つの書き方
 */
const PROTECTED = [
  /\{[^{}|\r\n]+\|[^{}|\r\n]*\}/g,
  /\{\{[^{}\r\n]+\}\}/g,
  /[|｜][^|｜《》\r\n]+《[^《》\r\n]*》/g,
  /[一-鿿々々]+《[^《》\r\n]*》/g,
  /#[^#\r\n]+?__[^#\r\n]*?__#/g,
];

/** 触ってはいけない範囲を集める */
function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of PROTECTED) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

function overlaps(
  start: number,
  end: number,
  ranges: ReadonlyArray<[number, number]>
): boolean {
  return ranges.some(([from, to]) => start < to && end > from);
}

/**
 * どこへ振るかを決める。**本文は書き換えない。**
 *
 * **長い名前を先に当てる。** 「ミナ」と「ミナモト」が両方あるとき、
 * 短いほうを先に取ると「ミナ」＋「モト」に割れる。
 */
export function planRubyInsertions(
  text: string,
  terms: readonly RubyTerm[],
  scope: RubyScope
): RubyInsertion[] {
  const usable = terms
    .filter((term) => term.text.trim() && term.reading.trim())
    .sort((a, b) => b.text.length - a.text.length);
  if (usable.length === 0) return [];

  const blocked = protectedRanges(text);
  const found: RubyInsertion[] = [];
  const taken: Array<[number, number]> = [];
  const done = new Set<string>();

  for (const term of usable) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(term.text, from);
      if (at < 0) break;
      const end = at + term.text.length;
      from = end;

      if (scope === "first" && done.has(term.text)) break;
      if (overlaps(at, end, blocked)) continue;
      // 長い名前がすでに取った場所へ、短い名前を重ねない
      if (overlaps(at, end, taken)) continue;

      found.push({ start: at, end, term });
      taken.push([at, end]);
      done.add(term.text);
      if (scope === "first") break;
    }
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * 決めたところへ実際に振る。
 *
 * **うしろから入れる。** 前から入れると、入れたぶんだけ後ろの位置がずれる。
 */
export function applyRubyInsertions(
  text: string,
  insertions: readonly RubyInsertion[]
): string {
  let result = text;
  for (const insertion of [...insertions].sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, insertion.start) +
      `{${insertion.term.text}|${insertion.term.reading}}` +
      result.slice(insertion.end);
  }
  return result;
}

/** 1つの本文へ振った結果 */
export interface RubyFileResult {
  filePath: string;
  /** 振った件数 */
  count: number;
  /** 振れなかった理由。あれば書き換えていない */
  skipped?: string;
}

/**
 * 作者に見せる要約。
 *
 * **話ごとの内訳まで出す。** 合計だけだと、どこへ入るのかが分からない。
 */
export function describeRubyResults(
  results: readonly RubyFileResult[],
  fileName: (filePath: string) => string
): string {
  const done = results.filter((entry) => entry.count > 0);
  const skipped = results.filter((entry) => entry.skipped);

  const lines: string[] = [];
  if (done.length > 0) {
    const total = done.reduce((sum, entry) => sum + entry.count, 0);
    lines.push(`${done.length}話に、あわせて${total}件のルビを振ります。`);
    for (const entry of done) {
      lines.push(`　${fileName(entry.filePath)}：${entry.count}件`);
    }
  } else {
    lines.push("振るところが見つかりませんでした。");
  }

  if (skipped.length > 0) {
    lines.push("");
    lines.push(`対象にできない話（${skipped.length}件）`);
    for (const entry of skipped) {
      lines.push(`　${fileName(entry.filePath)}：${entry.skipped}`);
    }
  }
  return lines.join("\n");
}
