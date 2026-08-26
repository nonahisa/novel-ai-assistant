import type { GitSyncStatus } from "./git";
import type { WorkEntry } from "../models/types";

/**
 * 「作品をすべて同期する」で、置き場ごとに何をするかを決める（設計書5.5.14）。
 *
 * 作者の依頼（2026-08-24）：「作品をすべて同期するを実装してください」。
 *
 * ## 作品ごとではなく、置き場ごとに動かす
 *
 * 既定では**1つのリポジトリに複数の作品**が入っている（書庫、5.7）。
 * 作品ごとに回すと、同じ置き場を作品の数だけ処理することになる。
 *
 * - 同じ変更を何度も記録しようとする（2回目からは「記録するものがない」）
 * - **送信の確認が作品の数だけ出る**
 *
 * **置き場を鍵にしてまとめてから動かす。**
 *
 * ## やる順番は 記録 → 取り込み → 送信
 *
 * - **記録が先。** 未コミットの変更があると取り込みを行わない決まり
 *   （5.5.1）。先に記録しておかないと、取り込みが必ず飛ばされる
 * - **取り込みが先、送信があと。** 別の環境が先に進んでいると送信は
 *   拒まれる。取り込んでからのほうが1回で通る
 *
 * VS Code APIに依存しない（状態は呼び出し側が読んで渡す）。
 */

/** 置き場1つぶんの、いまの状態 */
export interface SyncTargetState {
  folderPath: string;
  label: string;
  works: WorkEntry[];
  status: GitSyncStatus;
  /**
   * 記録していない変更の数。
   *
   * **`status.dirty` とは別に渡す。** あちらは自動で書き換わるもの
   * （執筆量の記録）を数えない（5.5.13）。**記録するときは全部入る**ので、
   * 「何件記録されるか」はこちらで数えたものを使う
   */
  trackable: number;
}

/** その置き場でやること */
export interface SyncTargetPlan {
  target: SyncTargetState;
  /** 記録する（コミットする）か */
  commit: boolean;
  /** 取り込むか */
  pull: boolean;
  /** 送信するか */
  push: boolean;
  /**
   * 何もしない理由。**やることが無いのと、できないのは違う。**
   * できないなら理由を出す
   */
  skip?: SkipReason;
}

export type SkipReason =
  /** gitコマンドが無い */
  | "git_missing"
  /** リポジトリではない（Gitを使わずに書いている作品） */
  | "not_a_repo"
  /** リモートが未設定。記録はできるが、送受信はできない */
  | "no_remote"
  /** 上流が未設定。まだ一度も送信していない */
  | "no_upstream"
  /** ブランチを見ていない */
  | "detached"
  /** 競合が解決していない */
  | "unmerged"
  /** 状態を読めなかった */
  | "failed"
  /** やることが無い（同期は取れている） */
  | "nothing";

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  git_missing: "gitが見つかりません",
  not_a_repo: "Gitで管理していません",
  no_remote: "送り先が未設定です",
  no_upstream: "まだ一度も送信していません",
  detached: "ブランチを見ていません",
  unmerged: "競合が解決していません",
  failed: "状態を読めませんでした",
  nothing: "同期は取れています",
};

/**
 * 置き場ごとの手順を決める。
 *
 * **競合が残っているものには触らない。** 記録すると競合マーカーごと
 * 履歴に入る（5.5.3）。
 */
export function planSyncTarget(target: SyncTargetState): SyncTargetPlan {
  const base = { target, commit: false, pull: false, push: false };
  const status = target.status;

  switch (status.kind) {
    case "git_missing":
      return { ...base, skip: "git_missing" };
    case "not_a_repo":
      return { ...base, skip: "not_a_repo" };
    case "detached":
      return { ...base, skip: "detached" };
    case "failed":
      return { ...base, skip: "failed" };
    case "no_remote":
      // 送り先が無くても、履歴に残すことはできる
      return target.trackable > 0
        ? { ...base, commit: true }
        : { ...base, skip: "no_remote" };
    case "no_upstream":
      return target.trackable > 0
        ? { ...base, commit: true, skip: "no_upstream" }
        : { ...base, skip: "no_upstream" };
    case "tracked":
      break;
  }

  // **競合マーカーを履歴へ入れない**（5.5.3）
  if (status.unmerged > 0) return { ...base, skip: "unmerged" };

  const commit = target.trackable > 0;
  const pull = status.behind > 0;
  // 記録するぶんも送る。記録すれば ahead が増える
  const push = status.ahead > 0 || commit;

  if (!commit && !pull && !push) return { ...base, skip: "nothing" };
  return { ...base, commit, pull, push };
}

/** 置き場をまとめて、やることを決める */
export function planSyncAll(
  targets: readonly SyncTargetState[]
): SyncTargetPlan[] {
  return targets.map(planSyncTarget);
}

/** 実際に動かすものだけ */
export function actionablePlans(
  plans: readonly SyncTargetPlan[]
): SyncTargetPlan[] {
  return plans.filter((plan) => plan.commit || plan.pull || plan.push);
}

/**
 * 何が起きるかを1行で書く。
 *
 * **押す前に、外へ何が出るのかが分かるようにする。**
 */
export function describePlan(plan: SyncTargetPlan): string {
  const parts: string[] = [];
  if (plan.commit) parts.push(`記録 ${plan.target.trackable}件`);
  if (plan.pull) {
    const status = plan.target.status;
    parts.push(
      `取り込み ${status.kind === "tracked" ? status.behind : 0}件`
    );
  }
  if (plan.push) {
    const status = plan.target.status;
    const ahead = status.kind === "tracked" ? status.ahead : 0;
    // 記録するぶんも送られる。数字だけ出すと足りなく見える
    parts.push(
      plan.commit ? `送信 ${ahead}件＋記録したぶん` : `送信 ${ahead}件`
    );
  }
  if (parts.length === 0) {
    return SKIP_REASON_TEXT[plan.skip ?? "nothing"];
  }
  return parts.join(" / ");
}

/**
 * 記録（コミット）の結果を、次にどうするかへ翻訳する。
 *
 * **「記録するものが無い」で打ち切らない**（2026-08-26、作者の実機）。
 * gitは記録するものが無いとき終了コード1を返す。これを失敗として扱って
 * いたため、
 *
 *   ・novel（…）：記録できませんでした: On branch main / nothing to commit
 *
 * と出て**そこで打ち切っていた**。この置き場は取り込み1件・送信11件を
 * 抱えており、**本当に必要な手順がまるごと飛んでいた。**
 *
 * 件数を数えてから記録するまでの間に、別の窓・前回の実行・作者自身の操作が
 * 先に記録すれば、記録するものは無くなる。**それは失敗ではない。**
 */
export function afterCommit(result: {
  ok: boolean;
  detail?: string;
  nothingToCommit?: boolean;
}): { stop: true; error: string } | { stop: false; committed: boolean } {
  if (!result.ok) {
    return {
      stop: true,
      error: `記録できませんでした: ${result.detail ?? "（詳細なし）"}`,
    };
  }
  return { stop: false, committed: !result.nothingToCommit };
}

/** 置き場の名前と、中の作品名 */
export function describeTargetWorks(target: SyncTargetState): string {
  if (target.works.length === 0) return target.label;
  if (target.works.length === 1) return target.works[0].title;
  return `${target.label}（${target.works
    .map((work) => work.title)
    .join("、")}）`;
}

/** 済んだあとの報告に使う結果 */
export interface SyncTargetOutcome {
  plan: SyncTargetPlan;
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  /** 途中で止まった理由。無ければ最後まで通った */
  error?: string;
}

/**
 * まとめの一言を作る。
 *
 * **できたことと、できなかったことを両方書く。** 「同期しました」だけだと、
 * 半分しか通っていないときに気づけない。
 */
export function describeOutcomes(outcomes: readonly SyncTargetOutcome[]): string {
  const pushed = outcomes.filter((one) => one.pushed).length;
  const pulled = outcomes.filter((one) => one.pulled).length;
  const committed = outcomes.filter((one) => one.committed).length;
  const failed = outcomes.filter((one) => one.error).length;

  const parts: string[] = [];
  if (committed > 0) parts.push(`記録 ${committed}か所`);
  if (pulled > 0) parts.push(`取り込み ${pulled}か所`);
  if (pushed > 0) parts.push(`送信 ${pushed}か所`);
  if (parts.length === 0 && failed === 0) return "同期するものはありませんでした。";

  const head = parts.length > 0 ? `${parts.join("・")}を済ませました。` : "";
  return failed > 0 ? `${head}${failed}か所は最後まで通りませんでした。` : head;
}
