/**
 * 適用した直しを「戻す」ときに、行のどこを戻すかを決める（設計書6.8.12）。
 *
 * ## なぜ切り出したか
 *
 * 戻す側は長らく `lineText.indexOf(item.suggestion)` で**行内の最初の一致**を
 * 書き換えていた。修正案が「なった」のような、ありふれた語のときは
 * **同じ行の別の場所を書き換える。** 実機で見つかった（2026-09-06）。
 *
 * 適用側は `item.original`（前後の文脈込みの原文）で位置を取っている。
 * 戻す側も同じ強さで位置を決める必要があるが、戻すときに行に在るのは
 * 原文ではなく**適用後の文**である。そこで「原文の `target` を
 * `suggestion` に置き換えた文字列」（適用後の文脈）を行内で探す。
 *
 * 判断だけを外へ出しておくと、VSCode の口を用意せずに単体テストで
 * 確かめられる。
 */

/** 位置を決めるのに要る情報だけ（`ProposalViewItem` の一部） */
export interface AppliedSuggestion {
  /** 検知したときの、前後の文脈を含む原文 */
  original: string;
  /** そのうち、実際に直した語 */
  target: string;
  /** 直したあとの語 */
  suggestion: string;
  /**
   * 適用したとき、修正案が行の何文字目に入ったか（0始まり）。
   *
   * **文脈でも1つに決まらないときの最後の手がかり。** 同じ文がその行に
   * 2度出てくることは実際にある（掛け合いの繰り返しなど）。
   */
  appliedAt?: number;
}

/**
 * 戻す位置を決めた結果。
 *
 * **「見つからない」と「決められない」を分ける。** 作者へ返す言葉が
 * 違う——前者は本文が書き換わったあと、後者は同じ文が複数ある行である。
 */
export type UndoLocation =
  | { kind: "found"; at: number }
  /** 適用後の文脈がその行に無い（作者が手で直したあとなど） */
  | { kind: "missing" }
  /** 適用後の文脈が複数あり、どれを戻すか決められない */
  | { kind: "ambiguous" }
  /** 指摘の形が壊れている（`original` が `target` を含まない等） */
  | { kind: "broken" };

/**
 * 適用後の文脈を組み立てる。
 *
 * 置き換えるのは**最初の `target` だけ**。適用側（`applyIssue`）が
 * `original.indexOf(target)` で位置を取っているので、そこと揃える。
 * 揃えないと、`target` が `original` に複数あるときに違う文字列を探す。
 */
function appliedContextOf(item: AppliedSuggestion): string | undefined {
  const targetIndexInOriginal = item.original.indexOf(item.target);
  if (targetIndexInOriginal === -1) return undefined;
  return (
    item.original.slice(0, targetIndexInOriginal) +
    item.suggestion +
    item.original.slice(targetIndexInOriginal + item.target.length)
  );
}

/** 行内に現れる位置をすべて拾う（重なる並びも取りこぼさない） */
function occurrencesOf(lineText: string, needle: string): number[] {
  const found: number[] = [];
  for (let from = lineText.indexOf(needle); from !== -1; ) {
    found.push(from);
    from = lineText.indexOf(needle, from + 1);
  }
  return found;
}

/**
 * 適用した修正案が、その行のどこに在るかを決める。
 *
 * 返すのは**修正案の先頭の位置**（行頭からの文字数）。呼び出し側は
 * そこから `suggestion.length` 文字を `target` へ差し替える。
 */
export function locateAppliedSuggestion(
  lineText: string,
  item: AppliedSuggestion
): UndoLocation {
  const targetIndexInOriginal = item.original.indexOf(item.target);
  if (targetIndexInOriginal === -1) return { kind: "broken" };

  const context = appliedContextOf(item);
  // 空文字は行内のどこにでも「在る」ことになってしまうので、手を出さない
  if (context === undefined || context === "") return { kind: "broken" };

  const starts = occurrencesOf(lineText, context);
  if (starts.length === 0) return { kind: "missing" };

  // **適用したときの列があれば、それが最も確かな手がかり。**
  // ただし行の前のほうが増減していれば当たらないので、
  // 当たらなかったときは文脈だけで決め直す
  if (item.appliedAt !== undefined) {
    const exact = starts.find(
      (start) => start + targetIndexInOriginal === item.appliedAt
    );
    if (exact !== undefined) return { kind: "found", at: item.appliedAt };
  }

  // 記録が無い（この直しより前に適用したもの）ときは、
  // **1つに決まるときだけ戻す。** 決まらないなら作者に委ねる
  if (starts.length > 1) return { kind: "ambiguous" };
  return { kind: "found", at: starts[0] + targetIndexInOriginal };
}
