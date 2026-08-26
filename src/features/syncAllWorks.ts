import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import {
  pullFastForward,
  push,
  readSyncStatus,
  runGit,
  type GitCommandRunner,
} from "../core/git";
import { commitAll, countTrackableFiles, hasCommitIdentity } from "../core/gitSetup";
import { buildSyncTarget } from "../core/syncTarget";
import {
  actionablePlans,
  describeOutcomes,
  describePlan,
  describeTargetWorks,
  planSyncAll,
  SKIP_REASON_TEXT,
  type SyncTargetOutcome,
  type SyncTargetPlan,
  type SyncTargetState,
} from "../core/syncAllPlan";
import { logFailure, logStep, showLog } from "../core/logger";
import { withCancellableProgress } from "../views/progress";
import type { GitSyncMonitorLike } from "./gitSyncStub";

/**
 * 作品をすべて同期する（設計書5.5.14）。
 *
 * 作者の依頼（2026-08-24）：「作品をすべて同期するを実装してください」。
 *
 * ## 1作品ずつ押さなくてよくする
 *
 * これまでの「GitHubと同期」は1作品ずつだった。作品が増えるほど、
 * 同じ手順を何度も踏むことになる。
 *
 * ## 置き場ごとにまとめる
 *
 * 既定では**1つのリポジトリに複数の作品**が入っている（書庫、5.7）。
 * 作品ごとに回すと同じ置き場を何度も処理し、**送信の確認が作品の数だけ
 * 出る**。置き場を鍵にしてまとめてから動かす。
 *
 * ## 確認は最初に1回だけ
 *
 * 送信は外へ出る操作なので確認が要る（5.5.1）。だが置き場ごとに訊くと、
 * 押しっぱなしの作業になって**読まずに押す**ようになる。
 * **何が起きるかを一覧で見せて、1回だけ訊く。**
 *
 * ## 1つ失敗しても、残りを続ける
 *
 * 置き場ごとに独立している。1つが拒まれても他は同期できるので、
 * **失敗を記録して続け、最後にまとめて報告する**（この作品の他の
 * 一括処理と同じ考え方）。
 */

export interface SyncAllDeps {
  registry: WorkRegistry;
  /** 済んだあとに状態表示を作り直すためだけに使う */
  monitor: GitSyncMonitorLike;
  run?: GitCommandRunner;
}

export async function syncAllWorks(deps: SyncAllDeps): Promise<void> {
  const works = deps.registry.list();
  if (works.length === 0) {
    void vscode.window.showInformationMessage(
      "登録されている作品がありません。先に作品を追加してください。"
    );
    return;
  }

  const states = await withCancellableProgress(
    "同期の状態を調べています…",
    async (progress, token) => collectStates(deps, works, progress, token)
  );
  if (!states) return;

  const plans = planSyncAll(states);
  const doing = actionablePlans(plans);
  if (doing.length === 0) {
    void vscode.window.showInformationMessage(
      `同期するものはありませんでした。${describeSkips(plans)}`
    );
    return;
  }

  if (!(await confirm(doing, plans))) return;

  const outcomes = await withCancellableProgress(
    "作品を同期しています…",
    async (progress, token) => {
      const done: SyncTargetOutcome[] = [];
      for (const [index, plan] of doing.entries()) {
        if (token.isCancellationRequested) break;
        progress.report({
          message: `${describeTargetWorks(plan.target)}（${index + 1}/${
            doing.length
          }）`,
        });
        done.push(await runPlan(deps, plan));
      }
      return done;
    }
  );
  if (!outcomes) return;

  // 状態表示を作り直す。押したのに件数が古いままだと、通ったのか分からない
  await deps.monitor.refreshAll({ fetch: false });

  await report(outcomes, plans);
}

/** 置き場ごとの状態を集める */
async function collectStates(
  deps: SyncAllDeps,
  works: readonly WorkEntry[],
  progress: { report(value: { message?: string }): void },
  token: vscode.CancellationToken
): Promise<SyncTargetState[]> {
  const states: SyncTargetState[] = [];
  const seen = new Set<string>();

  for (const work of works) {
    if (token.isCancellationRequested) break;
    progress.report({ message: work.title });

    const status = await readSyncStatus(work.folderPath, deps.run);
    // リポジトリの根が分かるなら、そこを置き場にする。
    // **同じ根の作品を二度処理しない**
    const root = "root" in status && status.root ? status.root : work.folderPath;
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const target = buildSyncTarget(root, deps.registry.list());
    // 記録される件数は、置き場の根で数える
    const trackable =
      status.kind === "not_a_repo" || status.kind === "git_missing"
        ? 0
        : await countTrackableFiles(root, deps.run ?? runGit);

    states.push({
      folderPath: root,
      label: target.label,
      works: target.works,
      status,
      trackable,
    });
  }
  return states;
}

/** 何が起きるかを見せて、1回だけ確認する */
async function confirm(
  doing: readonly SyncTargetPlan[],
  all: readonly SyncTargetPlan[]
): Promise<boolean> {
  const lines = doing.map(
    (plan) => `・${describeTargetWorks(plan.target)}：${describePlan(plan)}`
  );
  const sending = doing.filter((plan) => plan.push).length;

  const answer = await vscode.window.showInformationMessage(
    `${doing.length}か所を同期します。`,
    {
      modal: true,
      detail:
        `${lines.join("\n")}\n\n` +
        (sending > 0
          ? `${sending}か所はGitHubへ送信します。\n`
          : "GitHubへは送信しません（送り先が未設定です）。\n") +
        "記録の説明は、日付から自動で付けます。" +
        describeSkips(all),
    },
    "同期する"
  );
  return answer === "同期する";
}

/** 飛ばしたものの理由をまとめる */
function describeSkips(plans: readonly SyncTargetPlan[]): string {
  const skipped = plans.filter(
    (plan) => plan.skip && !plan.commit && !plan.pull && !plan.push
  );
  const notable = skipped.filter((plan) => plan.skip !== "nothing");
  if (notable.length === 0) return "";
  const detail = notable
    .map(
      (plan) =>
        `・${describeTargetWorks(plan.target)}：${
          SKIP_REASON_TEXT[plan.skip ?? "nothing"]
        }`
    )
    .join("\n");
  return `\n\n次は同期しません。\n${detail}`;
}

/**
 * 1つの置き場を同期する。
 *
 * **記録 → 取り込み → 送信の順に行う。** 途中で止まったら、そこで打ち切って
 * 理由を返す（続けても同じ理由で止まるため）。
 */
async function runPlan(
  deps: SyncAllDeps,
  plan: SyncTargetPlan
): Promise<SyncTargetOutcome> {
  const outcome: SyncTargetOutcome = {
    plan,
    committed: false,
    pulled: false,
    pushed: false,
  };
  const cwd = plan.target.folderPath;
  const run = deps.run ?? runGit;
  const name = describeTargetWorks(plan.target);

  if (plan.commit) {
    // **名前とメールアドレスが無いと、gitはコミットを作れない。**
    // ここで訊くと一括処理が止まるので、案内だけ出して飛ばす
    if (!(await hasCommitIdentity(cwd, run))) {
      outcome.error =
        "記録する人の名前が未設定です。「GitHubと同期」から一度設定してください。";
      return outcome;
    }
    const message = `${stamp()} の執筆（${plan.target.trackable}件）`;
    const result = await commitAll(cwd, message, run);
    if (!result.ok) {
      outcome.error = `記録できませんでした: ${result.detail ?? "（詳細なし）"}`;
      logFailure("すべて同期：記録に失敗", { 置き場: name, 詳細: outcome.error });
      return outcome;
    }
    outcome.committed = true;
    logStep(`すべて同期：記録（${name}／${plan.target.trackable}件）`);
  }

  if (plan.pull) {
    const result = await pullFastForward(cwd, deps.run);
    if (!result.ok) {
      outcome.error = describePullFailure(result.failure.kind);
      logFailure("すべて同期：取り込みに失敗", {
        置き場: name,
        詳細: outcome.error,
      });
      return outcome;
    }
    outcome.pulled = true;
    logStep(`すべて同期：取り込み（${name}）`);
  }

  if (plan.push) {
    const result = await push(cwd, deps.run);
    if (!result.ok) {
      outcome.error = `送信できませんでした: ${result.detail ?? "（詳細なし）"}`;
      logFailure("すべて同期：送信に失敗", { 置き場: name, 詳細: outcome.error });
      return outcome;
    }
    outcome.pushed = true;
    logStep(`すべて同期：送信（${name}）`);
  }

  return outcome;
}

function describePullFailure(kind: "dirty" | "diverged" | "failed"): string {
  if (kind === "dirty") {
    return "未記録の変更が残っているため取り込みませんでした。";
  }
  if (kind === "diverged") {
    return (
      "この環境と別の環境の両方で変更が進んでいます。" +
      "どちらを残すかは自動で決められないため、取り込みませんでした。"
    );
  }
  return "取り込めませんでした。";
}

/** 済んだあとの報告 */
async function report(
  outcomes: readonly SyncTargetOutcome[],
  plans: readonly SyncTargetPlan[]
): Promise<void> {
  const failed = outcomes.filter((one) => one.error);
  const summary = describeOutcomes(outcomes) + describeSkips(plans);

  if (failed.length === 0) {
    void vscode.window.showInformationMessage(summary);
    return;
  }

  // **通らなかったものは、置き場ごとに理由を出す。**
  // まとめて「失敗しました」だと、どれをどう直すか分からない
  const detail = failed
    .map((one) => `・${describeTargetWorks(one.plan.target)}：${one.error}`)
    .join("\n");
  const action = await vscode.window.showWarningMessage(
    summary,
    { modal: true, detail },
    "ログを表示"
  );
  if (action === "ログを表示") showLog();
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}
