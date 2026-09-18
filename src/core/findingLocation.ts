import { relocateQuote } from "./relocateQuote";
import type { Finding } from "../models/finding";

/**
 * 残しておいた指摘が、いまの本文のどこに在るかを決め直す（設計書6.96.3）。
 *
 * **行番号を鍵にしない。** 保存してある `hintLine` は検知した日のもので、
 * 三日ぶん書き足されればもう当てにならない。開くたびに `original` を
 * 本文から探し直し、前後の本文（`before` / `after`）で候補を絞る。
 *
 * **結末は3つしかない**——見つかった・動いた・消えた。当て推量で
 * 「たぶんこの辺」に置く道は作らない。存在しない場所を指す指摘は、
 * 押しても関係ない行へ飛ぶだけで、作者の時間を奪う（6.96.6）。
 */

export type FindingLocationStatus =
  /** 保存してあった行に、そのまま在った */
  | "found"
  /** 別の行へ動いていた。位置を更新して出す（作者には黙っていてよい） */
  | "moved"
  /** 本文のどこにも無い。**その指摘は捨てる** */
  | "lost";

export type FindingLocation =
  | { status: "found" | "moved"; line: number }
  | { status: "lost" };

/**
 * 指摘の現在位置。
 *
 * @param finding 残してあった指摘
 * @param text いまの本文（そのファイルの全文）
 */
export function locateFinding(
  finding: Pick<Finding, "hintLine" | "original" | "before" | "after">,
  text: string
): FindingLocation {
  const found = relocateQuote(text, finding.original, finding.hintLine, {
    before: finding.before,
    after: finding.after,
  });
  // **原文が本文に無ければ「消えた」。** 作者が直したか、消したか、
  // 書き換えたか——どれであっても、もうその指摘に用は無い
  if (found === undefined) return { status: "lost" };
  return {
    status: found === finding.hintLine ? "found" : "moved",
    line: found,
  };
}

/**
 * 残してあった指摘を、いまの本文の位置つきで並べ直す。
 *
 * **消えたものは返さない。** 呼び出し側が「捨てる」を忘れないように、
 * ここで落としきる。
 *
 * @param texts ファイル（`Finding.file` と同じ表記）→ その全文。
 *   **本文の読み込みは呼び出し側の仕事**である（`core` から
 *   `vscode` を触らないため）。ここに無いファイルの指摘は、位置を
 *   確かめようがないので**返さない**——「消えた」のではなく
 *   「まだ見ていない」だけなので、ファイルのほうからは消さない。
 */
export function locateFindings<T extends Finding>(
  findings: readonly T[],
  texts: ReadonlyMap<string, string>
): Array<T & { line: number; located: FindingLocationStatus }> {
  const located: Array<T & { line: number; located: FindingLocationStatus }> =
    [];
  for (const finding of findings) {
    const text = texts.get(finding.file);
    if (text === undefined) continue;
    const where = locateFinding(finding, text);
    if (where.status === "lost") continue;
    located.push({ ...finding, line: where.line, located: where.status });
  }
  // **話数 → 行の順**（6.96.5）。同じファイルなら行だけで並ぶ
  return located.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  );
}
