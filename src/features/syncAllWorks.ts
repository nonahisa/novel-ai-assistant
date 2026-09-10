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
import { readDivergenceConflicts } from "../core/divergenceScan";
import { foldDivergence } from "./resolveDivergence";
import {
  actionablePlans,
  afterCommit,
  describeOutcomes,
  describePlan,
  describeSyncSkips,
  describeTargetWorks,
  planSyncAll,
  syncCommitMessage,
  type FoldSummary,
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
  /**
   * 取り込みのあいだ、設定資料の見張りを止める（設計書5.5.18）。
   *
   * gitが書いたファイルも外部変更として拾うため、止めないと
   * 置き場の数だけ「拡張機能の外で変更されました」が出る
   */
  pauseSettingsWatch?: () => () => void;
  /**
   * ファイル更新の知らせをためて、最後に1回だけ出す（設計書5.5.18）。
   *
   * 返ってきた関数を呼ぶと、まとめて出す
   */
  batchFileNotices?: () => () => Promise<void>;
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
      `同期するものはありませんでした。${describeSyncSkips(plans)}`
    );
    return;
  }

  if (!(await confirm(doing, plans))) return;

  // **同期の最中は、設定資料の見張りとファイル更新の知らせを黙らせる**
  // （設計書5.5.18）。gitの書き込みで置き場の数だけ問いが並ぶのを防ぐ
  const resumeWatch = deps.pauseSettingsWatch?.();
  const flushNotices = deps.batchFileNotices?.();

  let outcomes: SyncTargetOutcome[] | undefined;
  try {
    outcomes = await withCancellableProgress(
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
          done.push(await runPlan(deps, plan, progress));
        }
        return done;
      }
    );
  } finally {
    resumeWatch?.();
  }
  if (!outcomes) {
    await flushNotices?.();
    return;
  }

  // 状態表示を作り直す。押したのに件数が古いままだと、通ったのか分からない
  await deps.monitor.refreshAll({ fetch: false });
  // ためた「N件のファイルが更新されました」を、ここで1回だけ出す
  await flushNotices?.();

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

    let status = await readSyncStatus(work.folderPath, deps.run);
    // **分かれているなら、同じ箇所の衝突の件数まで数える**（設計書5.5.18）。
    // 確認の画面で「選ぶことになるのか」が分かるようにするため
    if (status.kind === "tracked" && status.ahead > 0 && status.behind > 0) {
      const conflicts = await readDivergenceConflicts(
        status.root,
        status.upstream,
        deps.run ?? runGit
      );
      if (conflicts) status = { ...status, conflicts };
    }
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
        describeSyncSkips(all),
    },
    "同期する"
  );
  return answer === "同期する";
}

/**
 * 1つの置き場を同期する。
 *
 * **記録 → 取り込み → 送信の順に行う。** 途中で止まったら、そこで打ち切って
 * 理由を返す（続けても同じ理由で止まるため）。
 */
async function runPlan(
  deps: SyncAllDeps,
  plan: SyncTargetPlan,
  progress?: { report(value: { message?: string }): void }
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
    const message = syncCommitMessage(plan.target.trackable, new Date());
    const next = afterCommit(await commitAll(cwd, message, run));
    if (next.stop) {
      outcome.error = next.error;
      logFailure("すべて同期：記録に失敗", { 置き場: name, 詳細: outcome.error });
      return outcome;
    }
    // **記録するものが無いのは失敗ではない。** 止めると、本当に必要な
    // 取り込みと送信まで飛ぶ（それがこの不具合で起きていたことである）
    outcome.committed = next.committed;
    logStep(
      next.committed
        ? `すべて同期：記録（${name}／${plan.target.trackable}件）`
        : `すべて同期：記録するものは無かった（${name}）`
    );
  }

  if (plan.pull) {
    const result = await pullFastForward(cwd, deps.run);
    if (!result.ok) {
      // **分かれていても、ここで合わせにいく**（設計書5.5.18）。
      // 「『分かれた分を合わせる』でお試しください」と案内するだけでは、
      // 作者にとってそこが行き止まりだった
      if (result.failure.kind === "diverged") {
        const folded = await foldHere(deps, plan, progress);
        if (!folded.ok) {
          outcome.error = folded.reason;
          outcome.diverged = true;
          logFailure("すべて同期：分かれた分を合わせられなかった", {
            置き場: name,
            詳細: outcome.error,
          });
          return outcome;
        }
        outcome.pulled = true;
        outcome.folded = folded.summary;
        logStep(
          `すべて同期：分かれた分を合わせた（${name}／取り込み ${folded.summary.incoming}件` +
            `／設定資料 ${folded.summary.settings}件` +
            `／作者が選んだ ${folded.summary.manuscripts}件）`
        );
      } else {
        outcome.error = describePullFailure(result.failure.kind);
        logFailure("すべて同期：取り込みに失敗", {
          置き場: name,
          詳細: outcome.error,
        });
        return outcome;
      }
    } else {
      outcome.pulled = true;
      logStep(`すべて同期：取り込み（${name}）`);
    }
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

/**
 * 分かれた分を、この場で合わせる（設計書5.5.18）。
 *
 * **送信の手順はそのまま続く。** 合わせたぶんも `ahead` に載るので、
 * 続けて送信すれば1回の「すべて同期」で片が付く。
 */
async function foldHere(
  deps: SyncAllDeps,
  plan: SyncTargetPlan,
  progress?: { report(value: { message?: string }): void }
): Promise<
  { ok: true; summary: FoldSummary } | { ok: false; reason: string }
> {
  const status = await readSyncStatus(plan.target.folderPath, deps.run);
  if (status.kind !== "tracked") {
    return { ok: false, reason: "同期の状態を読めませんでした。" };
  }

  const result = await foldDivergence(
    { registry: deps.registry, run: deps.run },
    {
      root: status.root,
      label: describeTargetWorks(plan.target),
      upstream: status.upstream,
    },
    { progress }
  );
  if (!result.ok) return { ok: false, reason: result.reason };

  return {
    ok: true,
    summary: {
      incoming: result.incoming,
      settings: result.settingsAutoResolved.length,
      manuscripts: result.manuscriptConflicts.length,
      backup: result.backup,
    },
  };
}

function describePullFailure(kind: "dirty" | "failed"): string {
  if (kind === "dirty") {
    return "未記録の変更が残っているため取り込みませんでした。";
  }
  return "取り込めませんでした。";
}

/** 済んだあとの報告 */
async function report(
  outcomes: readonly SyncTargetOutcome[],
  plans: readonly SyncTargetPlan[]
): Promise<void> {
  const failed = outcomes.filter((one) => one.error);
  const summary = describeOutcomes(outcomes) + describeSyncSkips(plans);

  if (failed.length === 0) {
    void vscode.window.showInformationMessage(summary);
    return;
  }

  // **通らなかったものは、置き場ごとに理由を出す。**
  // まとめて「失敗しました」だと、どれをどう直すか分からない
  const detail = failed
    .map((one) => `・${describeTargetWorks(one.plan.target)}：${one.error}`)
    .join("\n");
  // 分岐で止まったものがあるなら、**その場から次の手へ行けるようにする**
  const diverged = failed.filter((one) => one.diverged);
  const buttons =
    diverged.length > 0 ? ["分かれた分を合わせる", "ログを表示"] : ["ログを表示"];
  const action = await vscode.window.showWarningMessage(
    summary,
    { modal: true, detail },
    ...buttons
  );
  if (action === "ログを表示") showLog();
  if (action === "分かれた分を合わせる") {
    const work = diverged[0]?.plan.target.works[0];
    await vscode.commands.executeCommand(
      "novelai.resolveDivergence",
      work ? { type: "work", work } : undefined
    );
  }
}
