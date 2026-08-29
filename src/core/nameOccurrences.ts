import { TermIndex, type TermEntry } from "./termIndex";

/**
 * 本文のどこに、その名前が出ているか（設計書6.37.4）。
 *
 * 点検画面の「登場箇所」と、付け替えの置換計画（6.37.3）が同じ走査を使う。
 * **2つに分けない**——片方だけがルビの中を見るようになると、画面に出た
 * 件数と実際に書き換わる件数が食い違う。
 *
 * 走査そのものは用語ハイライトの索引（`termIndex.ts`）に載せる。
 * 長い名前を先に当てる規則（「ミナ」より「ミナモト」）も、重なりの
 * 解消（`resolveOverlaps`）も、あちらが既に持っている。
 */

export interface NameOccurrence {
  /** 当たった名前。呼び出し側が渡した文字列そのもの */
  name: string;
  /** 本文の先頭からの位置 */
  start: number;
  end: number;
  /** 行番号。**1始まり**（提案パネル・エディタと揃える） */
  line: number;
  /** 行頭からの位置（0始まり） */
  column: number;
  /** 同じ行の直前・直後。画面に「前後の文」として出す */
  before: string;
  after: string;
}

export interface FindNameOccurrencesOptions {
  /** 前後に添える字数。既定は12字（一覧で1行に収まる長さ） */
  context?: number;
}

const DEFAULT_CONTEXT = 12;

/**
 * 本文から名前の登場箇所を拾う。
 *
 * **ルビの中も対象にする。** `{漢字|かんじ}` や `｜漢字《かんじ》` は
 * ルビを外さずそのまま走査するので、base（漢字）でも読み（かんじ）でも
 * 当たる。外してから探すと、付け替えのときにルビの中だけ旧名が残る。
 */
export function findNameOccurrences(
  text: string,
  names: string[],
  options: FindNameOccurrencesOptions = {}
): NameOccurrence[] {
  const context = options.context ?? DEFAULT_CONTEXT;
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0 || !text) return [];

  const entries: TermEntry[] = unique.map((name) => ({
    text: name,
    // 索引は種別で色を分けるためのものだが、ここでは使わない。
    // 探すことだけが目的なので、全部を同じ種別として入れる
    kind: "character",
    id: name,
    canonicalName: name,
  }));

  const lineStarts = buildLineStarts(text);
  return new TermIndex(entries).find(text).map((match) => {
    const line = lineIndexOf(lineStarts, match.start);
    const column = match.start - lineStarts[line];
    const lineEnd = lineEndOf(text, lineStarts, line);
    const lineText = text.slice(lineStarts[line], lineEnd);
    return {
      name: match.entry.text,
      start: match.start,
      end: match.end,
      line: line + 1,
      column,
      before: lineText.slice(Math.max(0, column - context), column),
      after: lineText.slice(
        column + match.entry.text.length,
        column + match.entry.text.length + context
      ),
    };
  });
}

/**
 * 各行の開始位置。
 *
 * **画面は常にLF空間で持つ**（`eolSpace.ts`）ので、ここも `\n` だけを見る。
 * CRLF のファイルでも、読み込みの境界で LF に揃っている。
 */
export function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/** その位置が何行目か（0始まり）。二分探索で引く */
function lineIndexOf(lineStarts: number[], position: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** その行の終わり（改行を含まない） */
function lineEndOf(text: string, lineStarts: number[], line: number): number {
  const next = lineStarts[line + 1];
  if (next === undefined) return text.length;
  // 直前の改行を落とす。CR は LF 空間では残っていない想定だが、
  // 外から素の文字列を渡されることもあるので念のため削る
  const end = next - 1;
  return text[end - 1] === "\r" ? end - 1 : end;
}
