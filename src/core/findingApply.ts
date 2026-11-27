/**
 * 修正案のある指摘1件を、本文の文字列へ当てる計算（設計書6.8・6.96.5）。`vscode` に触らない。
 *
 * 提案パネルの［適用］（`ProposalPanel.applyIssue`）から切り出した（2026-10-03、
 * 出先の原稿箱 6.115 の［直す］を MCP の取り込みから当てるとき）。**当て方は
 * ここ1か所**——パネルと MCP が同じ計算を通る。写しを置くと、片方だけ直る日が来る。
 *
 * 書き込み（ハッシュ照合・退避・文字コードの保持）は呼ぶ側の仕事。
 */

export interface FindingReplacement {
  /** 1始まりの行 */
  line: number;
  /** 指摘の原文（その行に実在するはずの文） */
  original: string;
  /** 原文の中の直す語 */
  target: string;
  /** 直したあとの語 */
  suggestion: string;
}

export type FindingApplyOutcome =
  /** 当てた。`at` はその行の中で修正案を入れた位置（戻すときの手がかり。6.8.12） */
  | { kind: "applied"; text: string; at: number }
  /** その行に原文が無い（検知から本文が変わった） */
  | { kind: "originalMissing" }
  /** 原文の中に直す語が無い */
  | { kind: "targetMissing" };

/**
 * `text` は LF で区切った本文（`decodeBytes` が返す形）。
 *
 * **その行に原文がまだ実在するかを確かめてから**置き換える。検知から
 * ここまでの間に本文が変わっている可能性がある。
 */
export function applyFindingToText(
  text: string,
  finding: FindingReplacement
): FindingApplyOutcome {
  const lines = text.split("\n");
  const lineIndex = finding.line - 1;
  const lineText = findingOriginalLine(lines, finding);

  if (lineText === undefined) {
    return { kind: "originalMissing" };
  }

  const originalIndexInLine = lineText.indexOf(finding.original);
  const targetIndexInOriginal = finding.original.indexOf(finding.target);
  if (targetIndexInOriginal === -1) {
    return { kind: "targetMissing" };
  }

  const at = originalIndexInLine + targetIndexInOriginal;
  lines[lineIndex] =
    lineText.slice(0, at) +
    finding.suggestion +
    lineText.slice(at + finding.target.length);

  return { kind: "applied", text: lines.join("\n"), at };
}

/**
 * 指摘の行に原文がまだ在れば、その行を返す（無ければ `undefined`）。
 * `applyFindingToText` が `originalMissing` を返すかどうかは、ここだけで決まる。
 *
 * **区切った行を受け取る**（動作の高速化、2026-11-27）。提案パネルの照らし直しは
 * 1つのファイルに何十件もの指摘を照らすので、1件ごとに全文を区切り直すと
 * 件数ぶん全文をなめる。呼ぶ側がファイルごとに1回区切って渡す。
 * **行の配列は書き換えない**（同じ配列を次の指摘にも使う）。
 *
 * @param lines `text.split("\n")` の結果（`applyFindingToText` と同じ区切り方）
 */
export function findingOriginalLine(
  lines: readonly string[],
  finding: Pick<FindingReplacement, "line" | "original">
): string | undefined {
  const lineText = lines[finding.line - 1];
  if (lineText === undefined || !lineText.includes(finding.original)) return undefined;
  return lineText;
}
