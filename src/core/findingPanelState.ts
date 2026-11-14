import { isFindingExpired, type FindingView } from "../models/finding";
import { locateFinding } from "./findingLocation";
import { findingRestoreOf } from "./findingSource";
import { isSjisMarkFinding, placeSjisMarkFindings } from "./sjisMarkFinding";

/**
 * 置き場（`.aiwriter/findings.jsonl`、設計書6.96）の指摘が、提案パネルで
 * どう扱われるか。
 *
 * **提案パネル（`features/primeFindings.ts`）と、外から読む道
 * （MCP `pending.list` の `kind: "finding"`。作者の裁定 2026-10-01）が
 * 同じ関数を通す。** 写しを置くと、画面に並ぶものと外から「未処理」と
 * 読めるものが、片方だけ直った日にずれる——外から当たり率を測る目的
 * （6.49.7）では、そのずれがそのまま測り違いになる。
 *
 * `vscode` に触らない（本文の読み込みは呼び出し側の仕事）。もとは
 * `features/findingStore.ts` に在った `visibleFindings` をここへ移し、
 * あちらは再輸出で受けている。
 */

/** 残す日数の既定（`novelai.findings.retentionDays` の既定と同じ。作者の指示で3日） */
export const DEFAULT_FINDINGS_RETENTION_DAYS = 3;

/**
 * 並べてよい1件か（設計書6.96.4）。
 *
 * **期限切れは隠すだけで、ファイルからは消さない。** 判断の済んだものも
 * 並べない——採ったものはもう本文に入っており、退けたものは作者が
 * 「要らない」と言ったものである。
 */
export function isVisibleFinding(
  finding: FindingView,
  retentionDays: number,
  now: Date = new Date()
): boolean {
  return (
    finding.status === "pending" &&
    !isFindingExpired(finding.time, retentionDays, now)
  );
}

/**
 * 並べてよい指摘だけを残す（設計書6.96.4）。
 *
 * @param now 試験のために外から渡す。既定はいまの時刻
 */
export function visibleFindings(
  findings: readonly FindingView[],
  retentionDays: number,
  now: Date = new Date()
): FindingView[] {
  return findings.filter((finding) =>
    isVisibleFinding(finding, retentionDays, now)
  );
}

/**
 * 提案パネルでの扱い。
 *
 * - `pending`：パネルに並ぶ（作者がまだ決めていない）
 * - `accepted`：作者が採った（本文へ当てた）
 * - `dismissed`：作者が退けた（無視・見送る）
 * - `expired`：決めないまま期限（`retentionDays`）を過ぎた。並ばない
 * - `stale`：原文が本文から消えた（作者が自分で書き直した等）。並ばない
 * - `unchecked`：本文が読めず、位置を確かめられない。並ばない
 *   （「消えた」のではなく「まだ見ていない」）
 * - `unrestorable`：パネルへ戻す道の決まっていない種類。並ばない
 */
export type FindingPanelState =
  | "pending"
  | "accepted"
  | "dismissed"
  | "expired"
  | "stale"
  | "unchecked"
  | "unrestorable";

export const FINDING_PANEL_STATES: readonly FindingPanelState[] = [
  "pending",
  "accepted",
  "dismissed",
  "expired",
  "stale",
  "unchecked",
  "unrestorable",
];

/** 作者にも読める呼び名 */
export const FINDING_PANEL_STATE_LABELS: Readonly<
  Record<FindingPanelState, string>
> = {
  pending: "未処理（提案パネルに並ぶ）",
  accepted: "採用（作者が本文へ当てた）",
  dismissed: "却下（作者が退けた）",
  expired: "期限切れ（決めないまま日数を過ぎ、並ばない）",
  stale: "陳腐化（原文が本文から消え、並ばない）",
  unchecked: "未確認（本文を読めず、位置を確かめられない）",
  unrestorable: "対象外（提案パネルへ戻す道の無い種類）",
};

/**
 * 1件の扱いと、いまの行。
 *
 * **落とす順は提案パネルと同じ**：判断と期限（`isVisibleFinding`）→
 * 戻し方の有無（`findingRestoreOf`）→ 本文での位置（`locateFinding`）。
 * パネルはどの理由で落としても「並ばない」だけなので、順番は呼び名を
 * 決めるためだけに効く。判断の済んだものは、期限切れより判断を先に返す
 * （採否の記録として読みたいのはそちら）。
 *
 * @param text いまの本文（そのファイルの全文）。読めなければ `undefined`
 * @returns `line` は並ぶものなら探し直した行、それ以外は検知したときの行
 */
export function findingPanelStateOf(
  finding: FindingView,
  text: string | undefined,
  retentionDays: number,
  now: Date = new Date()
): { state: FindingPanelState; line: number } {
  const hint = { line: finding.hintLine };
  if (finding.status === "accepted" || finding.status === "dismissed") {
    return { state: finding.status, ...hint };
  }
  if (!isVisibleFinding(finding, retentionDays, now)) {
    return { state: "expired", ...hint };
  }
  if (!findingRestoreOf(finding)) return { state: "unrestorable", ...hint };
  if (text === undefined) return { state: "unchecked", ...hint };
  const where = locateFinding(finding, text);
  if (where.status === "lost") return { state: "stale", ...hint };
  return { state: "pending", line: where.line };
}

/**
 * 置き場の指摘を**まとめて**、パネルでの扱いにする（実装の残り 116行）。
 *
 * **「Shift_JIS に無い字」の行（〓の行）は、校正・メモパネルと同じ決め方にする**（設計書5.4.2・
 * 6.96.4 の例外）。1件ずつの `findingPanelStateOf` では揃わない——〓の行は日付で隠さず、
 * 提案パネルへ戻す表にも入れていない（1件ずつだと `expired` か `unrestorable` になる）うえ、
 * 生き死には本文の〓との**1対1の突き合わせ**（`placeSjisMarkFindings`。見送った行も〓を
 * 取っておく）で決まるので、同じファイルの〓の行を一度に見る必要がある。
 *
 * - 採った・退けた：その判断
 * - 本文が読めない：`unchecked`
 * - 〓が割り当たった未決の行：`pending`（行は〓のいまの行）
 * - 割り当たらなかった未決の行：`stale`（〓が本文から無くなった＝直した）
 *
 * ほかの指摘は `findingPanelStateOf` のまま。並びは渡した順。
 *
 * @param texts ファイル（`Finding.file` と同じ表記）→ その全文。読めないファイルは入れない
 */
export function findingPanelStatesOf<T extends FindingView>(
  findings: readonly T[],
  texts: ReadonlyMap<string, string>,
  retentionDays: number,
  now: Date = new Date()
): Array<{ finding: T; state: FindingPanelState; line: number }> {
  // 判断も日付も見ずに全部渡す（パネルの `loadVisibleFindings` の `marks` と同じ）
  const placed = new Map(
    placeSjisMarkFindings(findings.filter(isSjisMarkFinding), texts).map((row) => [row.id, row.line])
  );
  return findings.map((finding) => {
    if (!isSjisMarkFinding(finding)) {
      return { finding, ...findingPanelStateOf(finding, texts.get(finding.file), retentionDays, now) };
    }
    const hint = finding.hintLine;
    if (finding.status === "accepted" || finding.status === "dismissed") {
      return { finding, state: finding.status, line: hint };
    }
    if (!texts.has(finding.file)) return { finding, state: "unchecked", line: hint };
    const line = placed.get(finding.id);
    return line === undefined
      ? { finding, state: "stale", line: hint }
      : { finding, state: "pending", line };
  });
}
