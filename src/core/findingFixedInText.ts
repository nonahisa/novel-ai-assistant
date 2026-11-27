import { findingOriginalLine, type FindingReplacement } from "./findingApply";
import { locateFinding } from "./findingLocation";
import { normalizeForComparison } from "./groundedEvidence";
import { hasConflictMarkers } from "./textDecode";

/**
 * 指摘を出したあとに、作者が本文のその所を自分で直したか（作者の知らせ
 * 2026-11-27「誤字脱字を直接書き換えるとパネルから消えない」。設計書6.96.5）。
 * `vscode` に触らない。本文の読み込みは呼ぶ側の仕事。
 *
 * ## 物差しは2つを重ねる
 *
 * 1. **［当てる］と同じ照らし**（`applyFindingToText` の `originalMissing`）。
 *    その行に原文が無ければ、当てる道はもう通らない
 * 2. **校正・メモパネルと同じ探し直し**（`locateFinding` の `lost`）。
 *    本文のどこにも原文が無いときだけ「直された」とする
 *
 * 1だけで決めると、作者が上に1行足しただけで、その下の指摘が全部
 * 「直された」になって消える。2だけで決めると、2つのパネルの照らし方が
 * ［当てる］とずれる。両方が「無い」と言ったときだけ外す。
 *
 * **行は付け直さない**（実装ルール3）。動いただけの指摘は残し、［当てる］は
 * 今までどおり `originalMissing` で止まる——AIの出した位置を推し量らない。
 */
export function isFixedInText(
  text: string,
  row: FindingReplacement,
  /**
   * `text.split("\n")` を済ませた行（動作の高速化、2026-11-27）。同じ本文で
   * 何件も照らす呼び手（提案パネル）が、ファイルごとに1回だけ区切って渡す。
   * 渡さなければここで区切る。判断は渡しても渡さなくても同じ
   */
  lines: readonly string[] = text.split("\n")
): boolean {
  // 原文の無い指摘は照らしようがない（消えたことにしない）。探し直しは空白を
  // 除いて比べるので、除いて空になる原文も同じ（探し直しが「無い」を返してしまう）
  if (normalizeForComparison(row.original) === "") return false;
  // ［当てる］と同じ照らし（`applyFindingToText` が `originalMissing` を返すかと同じ判定）
  if (findingOriginalLine(lines, row) !== undefined) return false;
  return (
    locateFinding(
      { hintLine: row.line, original: row.original, before: "", after: "" },
      text
    ).status === "lost"
  );
}

/**
 * その本文で照らしてよいか。
 *
 * **空に見える本文では照らさない。** VS Code の保存はいったんファイルを空にして
 * から書き、この拡張機能の書き戻しは退避のあいだ一瞬ファイルが無い。その瞬間を
 * 読むと、全部の指摘が「直された」になる（次の知らせで戻るが、一覧が瞬く）。
 *
 * **競合マーカーを含む本文でも照らさない**（実装ルール1）。どちらが本文か
 * 決められないので、直されたかどうかも決められない。
 */
export function canCheckFixedInText(text: string): boolean {
  return text.trim() !== "" && !hasConflictMarkers(text);
}
