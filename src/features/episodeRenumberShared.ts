import * as vscode from "vscode";
import type { EpisodeFile, WorkEntry } from "../models/types";
import * as path from "../core/paths";
import {
  readSyncStatus,
  runGit,
  type GitCommandRunner,
  type GitSyncStatus,
} from "../core/git";
import { logFailure } from "../core/logger";
import type {
  EpisodeRename,
  RenumberOutcome,
  RenumberPlan,
} from "../core/episodeRenumber";
import { describeLedgerFollowSummary, type LedgerFollowSummary } from "./episodeLedgers";

/**
 * 挿入・削除で共通に使う部品（設計書6.67）。
 *
 * **`core/git.ts` を静的importする。** `node:child_process` を巻き込むため、
 * このファイルとそれを使う `insertEpisode.ts`／`removeEpisode.ts` は、
 * `extension.ts` から必ず動的import（`await import(...)`）で読み込むこと
 * （`features/gitSync.ts` と同じ約束、設計書5.8.5）。
 */

const LOCAL_TIMEOUT_MS = 15_000;

/** 付け替えの範囲に競合マーカーの残る話が含まれていないか（設計書6.67の実装指示） */
export function findConflictedEpisodes(
  episodes: readonly EpisodeFile[],
  renames: readonly EpisodeRename[]
): EpisodeFile[] {
  const targets = new Set(
    renames.map((rename) => path.normalizeForComparison(rename.fromPath))
  );
  return episodes.filter(
    (episode) =>
      episode.hasConflictMarkers &&
      targets.has(path.normalizeForComparison(episode.filePath))
  );
}

/** 動かせなかった話があれば、確認ダイアログに添える説明にする */
export function describeSkippedDetail(plan: RenumberPlan): string | undefined {
  if (plan.skipped.length === 0) return undefined;
  return (
    `動かせない話が${plan.skipped.length}件あります（そのままです）：` +
    plan.skipped.map((s) => `${s.fileName}（${s.detail}）`).join("\n")
  );
}

/**
 * 実行結果を作者へ伝える（設計書6.67.2・6.67.3）。
 *
 * 1件でも失敗して止まっていれば、**どこまで進んだかを必ず出す**。
 * 台帳への追従が一部失敗していても、原稿の付け替え自体は取り消さない
 * ——そのことが伝わるよう、成功と失敗を分けて書く。
 */
export function reportRenumberOutcome(
  action: "挿入" | "削除",
  pivot: number,
  outcome: RenumberOutcome,
  summary: LedgerFollowSummary
): void {
  const ledgerText = describeLedgerFollowSummary(summary);
  const failureText =
    summary.failures.length > 0
      ? `\n台帳への追従で失敗したもの：\n${summary.failures.join("\n")}`
      : "";

  if (outcome.stoppedAt) {
    const doneText =
      outcome.done.length > 0
        ? `${outcome.done.length}件は済みました：` +
          outcome.done.map((r) => `${r.fromFileName}→${r.toFileName}`).join("、")
        : "1件も済んでいません。";
    void vscode.window.showErrorMessage(
      `話数の${action}が「${outcome.stoppedAt.rename.fromFileName}」の付け替えで止まりました：` +
        `${outcome.stoppedAt.detail}\n${doneText}` +
        (ledgerText ? `\n${ledgerText}` : "") +
        failureText,
      { modal: true }
    );
    return;
  }

  void vscode.window.showInformationMessage(
    outcome.done.length > 0
      ? `第${pivot}話以降、${outcome.done.length}件の話数を付け替えました。${ledgerText}`
      : `付け替える話はありませんでした。${ledgerText}`
  );
  if (failureText) {
    void vscode.window.showWarningMessage(
      `話数の付け替え自体は完了しましたが、一部の台帳を追従できませんでした：` +
        summary.failures.join("　")
    );
  }
}

/**
 * 「名前の変更だけの独立コミット」（設計書6.67.1）。
 *
 * Git管理下でない作品では何も訊かない。**`-A` は使わず、付け替えたファイル
 * だけを名指しでステージする**——挿入で新しく作ったファイルは含めない
 * （呼び出し側が `done` にそのファイルを混ぜないこと）。
 */
export async function offerIndependentRenameCommit(
  work: WorkEntry,
  done: readonly EpisodeRename[],
  message: string,
  run: GitCommandRunner = runGit
): Promise<void> {
  if (done.length === 0) return;

  const status = await readSyncStatus(work.folderPath, run);
  const root = repoRootOf(status);
  if (!root) return; // Gitを使っていない作品では、コミットの話をしない

  const answer = await vscode.window.showInformationMessage(
    "名前の変更だけを独立したコミットにしますか？",
    {
      modal: true,
      detail:
        "内容を書き換えず、名前だけを変えたコミットにします。" +
        "GitHub上でも「改名」として履歴がつながります。",
    },
    "コミットする"
  );
  if (answer !== "コミットする") return;

  const paths = done.flatMap((rename) => [rename.fromPath, rename.toPath]);
  const added = await run(["add", "--", ...paths], root, LOCAL_TIMEOUT_MS);
  if (added.code !== 0) {
    reportGitFailure("追加", added.stderr || added.stdout);
    return;
  }
  const committed = await run(["commit", "-m", message], root, LOCAL_TIMEOUT_MS);
  if (committed.code !== 0) {
    reportGitFailure("記録", committed.stderr || committed.stdout);
  }
}

function repoRootOf(status: GitSyncStatus): string | undefined {
  return "root" in status ? status.root : undefined;
}

function reportGitFailure(step: "追加" | "記録", detail: string): void {
  logFailure("話数付け替えの独立コミット", { 段階: step, 内容: detail });
  void vscode.window.showErrorMessage(
    `話数の付け替えは完了しましたが、名前だけのコミットを${step}できませんでした：${detail.trim()}`
  );
}
