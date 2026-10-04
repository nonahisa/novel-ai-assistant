import {
  OUTBOX_DECISION_NOTES,
  isFindingExpired,
  type Finding,
  type FindingView,
} from "../models/finding";
import { findingAppliesDirectly, findingRestoreOf } from "./findingSource";
import { appliedContextOf, locateAppliedSuggestion } from "./proposalUndo";
import { relocateQuote } from "./relocateQuote";

/**
 * 提案パネルの「当てたもの」（作者の裁定 2026-10-04。設計書6.96.5・6.115）。
 *
 * 提案パネルは開くときに置き場（`.aiwriter/findings.jsonl`）の**未処理**しか
 * 並べない（`visibleFindings`）。そのため、次の直しを、あとからパネルの
 * ［戻す］で戻す口が無かった——記録は戻せる形で残っているのに。
 *
 * - 原稿箱の取り込みで当てた［直す］［自分で直す］（6.115）
 * - 校正・メモパネルの［直す］1手（6.96.5）
 * - パネルを閉じる前に［適用］したもの（拡張機能を起こし直したあと）
 *
 * ここは「どれを並べるか」と「いまの本文のどの行か」だけを決める。戻す処理は
 * 提案パネルの既存の［戻す］（`undoIssue` → `locateAppliedSuggestion`）を通す。
 * `vscode` に触らない（本文の読み込みは呼び出し側の仕事）。
 */

/**
 * 誰がどこで当てたか。**判断の行の覚え書き（`note`）で分かる範囲だけ。**
 *
 * - `here`：このパソコンで当てた。提案パネルの［適用］と校正・メモパネルの［直す］は
 *   同じ関数を通り、覚え書きを残さない（空）ので、この2つは見分けられない
 * - `remote`：出先で［直す］を押し、取り込みで当てた
 * - `remoteOwnWords`：出先で［自分で直す］——作者の文に置き換えた
 */
export type AppliedBy = "here" | "remote" | "remoteOwnWords";

export const APPLIED_BY_LABELS: Readonly<Record<AppliedBy, string>> = {
  here: "パソコンで当てた",
  remote: "出先で当てた",
  remoteOwnWords: "出先で自分で直した",
};

/**
 * 覚え書きから「誰がどこで」を読む。**本文に修正案が入った判断でなければ `undefined`。**
 *
 * 並べないもの（覚え書きで落とす）：
 * - ［済み］（`done`）——本文には触れていない。戻すものが無い
 * - ［自分で直す］の元のAIの指摘（`editOriginal`）——本文に入ったのはAIの修正案では
 *   なく作者の文で、そちらは別の行（`authorEdit`）として並ぶ。AIの行で戻そうとしても
 *   本文にAIの修正案は無い
 * - 知らない覚え書き——何をした記録か分からないものは、戻す口を出さない
 */
export function appliedByOf(note: string): AppliedBy | undefined {
  if (note === "") return "here";
  if (note === OUTBOX_DECISION_NOTES.fix) return "remote";
  if (note === OUTBOX_DECISION_NOTES.authorEdit) return "remoteOwnWords";
  return undefined;
}

/** 「当てたもの」に並べる候補（本文での位置はまだ決めていない） */
export interface AppliedFindingCandidate {
  finding: FindingView;
  appliedBy: AppliedBy;
  /** 当てた時刻（判断の行の `time`）。**期限の起点** */
  appliedTime: string;
  /** 戻すときに通す提案パネルの分類（タブの名前） */
  panelCategory: string;
}

/**
 * 直近に当てた指摘を、新しい順に並べる。
 *
 * **期限の起点は当てた時刻**（判断の行の `time`）。検知した時刻（`Finding.time`）では
 * ない——「直近◯日に当てたもの」を出す欄なので、3日前に検知して今日当てたものは
 * 並ぶべきである。日数は指摘の期限の設定（`novelai.findings.retentionDays`）に揃える
 * （呼び出し側が渡す）。`0` 以下なら無期限。
 *
 * @param now 試験のために外から渡す。既定はいまの時刻
 */
export function recentAppliedFindings(
  findings: readonly FindingView[],
  retentionDays: number,
  now: Date = new Date()
): AppliedFindingCandidate[] {
  const candidates: AppliedFindingCandidate[] = [];
  for (const finding of findings) {
    const decision = finding.decision;
    if (finding.status !== "accepted" || !decision) continue;
    const appliedBy = appliedByOf(decision.note);
    if (!appliedBy) continue;
    // 本文の置き換えの形で、修正案のあるものだけ（戻す道があるもの）
    const restore = findingRestoreOf(finding);
    if (!restore || restore.shape !== "item") continue;
    if (!findingAppliesDirectly(finding)) continue;
    if (isFindingExpired(decision.time, retentionDays, now)) continue;
    candidates.push({
      finding,
      appliedBy,
      appliedTime: decision.time,
      panelCategory: restore.panelCategory,
    });
  }
  // 新しく当てたものを上へ。時刻が読めないものは下へ
  // （どちらも読めないと引き算が NaN になるので、そのときは並びを変えない）
  return candidates.sort(
    (a, b) => timeOf(b.appliedTime) - timeOf(a.appliedTime) || 0
  );
}

/**
 * 当てた指摘が、いまの本文の何行目に在るか（1始まり）。見つからなければ `undefined`。
 *
 * **当てたあとの本文に `original` は無い。** 置き場の引用（`locateFinding`）では
 * 必ず「消えた」になるので、`original` の `target` を `suggestion` に置き換えた文
 * （当てたあとの文脈。`proposalUndo.ts` の `appliedContextOf`）で探す。
 *
 * **見つけた行で、［戻す］と同じ照合も通す。** 行は正規化して探すので、
 * 正規化の差で「見つかったのに戻せない」行が並ぶのを避ける。同じ文が1行に
 * 2度あって決められない（`ambiguous`）ものは並べる——押せば既存の［戻す］が
 * その理由を出す（並べないと、作者は当てたことを確かめる手がかりを失う）。
 *
 * 並べないもの：作者がそのあと書き換えた行（`missing`）、指摘の形が壊れている
 * （`broken`）。どちらも戻す先が本文に無い。
 */
export function locateAppliedFinding(
  finding: Pick<
    Finding,
    "hintLine" | "original" | "target" | "suggestion" | "before" | "after"
  >,
  text: string
): number | undefined {
  const context = appliedContextOf(finding);
  if (context === undefined || context === "") return undefined;
  const line = relocateQuote(text, context, finding.hintLine, {
    before: finding.before,
    after: finding.after,
  });
  if (line === undefined) return undefined;
  const lineText = text.split(/\r\n|\r|\n/u)[line - 1] ?? "";
  const located = locateAppliedSuggestion(lineText, finding);
  return located.kind === "found" || located.kind === "ambiguous"
    ? line
    : undefined;
}

function timeOf(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
