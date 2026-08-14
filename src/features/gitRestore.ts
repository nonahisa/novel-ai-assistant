import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { readSyncStatus, runGit } from "../core/git";
import { commitAll } from "../core/gitSetup";
import {
  HISTORY_LIMIT,
  isEmptyPlan,
  listCommits,
  planRestore,
  restoreToCommit,
  type CommitEntry,
  type RestorePlan,
} from "../core/gitHistory";
import { logFailure } from "../core/logger";
import { withProgress } from "../views/progress";

/**
 * 過去の版に戻す（設計書5.5.10）。
 *
 * 「昨日の状態に戻したい」は、書き直して失敗したときに必ず出てくる要求である。
 * ただし**戻す操作そのものが原稿を失う原因になってはいけない**ので、
 * 次の順で行う。
 *
 * 1. 今の状態を履歴へ残す（戻したあとで「やっぱり元に」ができる）
 * 2. 選んだ版の中身を書き戻す
 * 3. 戻したことを1つの変更として履歴へ残す
 *
 * `reset --hard` のような、過去を書き換える方法は使わない。
 */
export async function restoreFromHistory(work: WorkEntry): Promise<void> {
  const status = await readSyncStatus(work.folderPath);
  if (status.kind === "git_missing") {
    vscode.window.showInformationMessage(
      "Gitが見つからないため、過去の版を扱えません。" +
        "「GitHubのセットアップ」から導入方法を確認できます。"
    );
    return;
  }
  if (status.kind === "not_a_repo") {
    vscode.window.showInformationMessage(
      `「${work.title}」はまだGitで管理されていないため、戻せる過去の版がありません。` +
        "「GitHubのセットアップ」から始められます。"
    );
    return;
  }
  if (status.kind === "failed") {
    vscode.window.showErrorMessage(`履歴を読めませんでした: ${status.detail}`);
    return;
  }

  const commits = await withProgress("過去の版を読んでいます…", () =>
    listCommits(work.folderPath)
  );
  if (commits.length === 0) {
    vscode.window.showInformationMessage(
      "まだ履歴がありません。一度も送信していない作品は戻せません。"
    );
    return;
  }
  if (commits.length === 1) {
    vscode.window.showInformationMessage(
      "履歴が1件しかないため、戻せる過去の版がありません。"
    );
    return;
  }

  const picked = await pickCommit(work, commits);
  if (!picked) return;

  const plan = await withProgress("戻すと何が変わるかを調べています…", () =>
    planRestore(work.folderPath, picked.id)
  );
  if (isEmptyPlan(plan)) {
    vscode.window.showInformationMessage(
      "その版と今の内容は同じです。戻す必要はありません。"
    );
    return;
  }

  const confirmed = await confirmRestore(picked, plan);
  if (!confirmed) return;

  // 1. 今の状態を退避する。戻したあとで「やっぱり元に」ができるようにする。
  //    変更が無ければコミットは作られない（commitAllが失敗するだけ）ので、
  //    その場合は先へ進む
  const dirty = status.kind === "tracked" ? status.dirty : 1;
  if (dirty > 0) {
    const saved = await withProgress("いまの原稿を履歴へ残しています…", () =>
      commitAll(
        work.folderPath,
        `復元の前に自動保存（${new Date().toLocaleString("ja-JP")}）`,
        runGit
      )
    );
    if (!saved.ok) {
      logFailure("復元前の自動保存", {
        作品: work.title,
        詳細: saved.detail ?? "",
      });
      const action = await vscode.window.showErrorMessage(
        "いまの原稿を履歴へ残せなかったため、復元を中止しました。" +
          "原稿には手を触れていません。",
        "ログを表示",
        "閉じる"
      );
      if (action === "ログを表示") {
        await vscode.commands.executeCommand("novelai.showLog");
      }
      return;
    }
  }

  // 2. 選んだ版の中身を書き戻す
  const restored = await withProgress("原稿を戻しています…", () =>
    restoreToCommit(work.folderPath, picked.id, plan)
  );
  if (!restored.ok) {
    logFailure("過去の版への復元", {
      作品: work.title,
      版: picked.shortId,
      詳細: restored.detail ?? "",
    });
    vscode.window.showErrorMessage(
      `復元できませんでした: ${restored.detail ?? "理由は不明です"}`
    );
    return;
  }

  // 3. 戻したことを履歴に残す。残さないと、次の同期で
  //    「大量に変更された」とだけ見え、何が起きたのか分からなくなる
  const recorded = await commitAll(
    work.folderPath,
    `${picked.date} の版に戻した（${picked.shortId}）`,
    runGit
  );
  if (!recorded.ok) {
    logFailure("復元内容の記録", {
      作品: work.title,
      詳細: recorded.detail ?? "",
    });
  }

  const action = await vscode.window.showInformationMessage(
    `${picked.date} の版に戻しました。` +
      "元に戻したい場合は、もう一度「復元」で1つ前の版を選んでください。",
    "GitHubへ送信",
    "閉じる"
  );
  if (action === "GitHubへ送信") {
    await vscode.commands.executeCommand("novelai.gitPush");
  }
}

async function pickCommit(
  work: WorkEntry,
  commits: CommitEntry[]
): Promise<CommitEntry | undefined> {
  // 先頭は「今の状態」そのものなので、戻し先には出さない
  const candidates = commits.slice(1);
  const picked = await vscode.window.showQuickPick(
    candidates.map((commit) => ({
      label: `$(history) ${commit.date}`,
      description: commit.subject,
      detail: `版 ${commit.shortId}`,
      commit,
    })),
    {
      title: `「${work.title}」をどの版に戻しますか？（新しい順に最大${HISTORY_LIMIT}件）`,
      placeHolder: "戻したい日時を選んでください",
      ignoreFocusOut: true,
    }
  );
  return picked?.commit;
}

/**
 * 戻すと何が起きるかを見せて確かめる。
 *
 * **消えるファイルの件数と名前を必ず出す。** 選んだ版より後に書いた話は
 * 無くなるので、ここで気づけないと取り返しがつかない（履歴には残るが、
 * 作者がそれを知らなければ同じことである）。
 */
async function confirmRestore(
  commit: CommitEntry,
  plan: RestorePlan
): Promise<boolean> {
  const lines = [
    `${plan.changed.length} 個のファイルが、その時点の内容に戻ります。`,
  ];
  if (plan.addedSince.length > 0) {
    lines.push(
      `${plan.addedSince.length} 個のファイルが消えます（その版より後に作ったもの）:`,
      `  ${sample(plan.addedSince)}`
    );
  }
  if (plan.removedSince.length > 0) {
    lines.push(
      `${plan.removedSince.length} 個のファイルが復活します:`,
      `  ${sample(plan.removedSince)}`
    );
  }
  lines.push(
    "",
    "いまの原稿は、戻す前に履歴へ自動で残します。あとから戻し直せます。"
  );

  const answer = await vscode.window.showWarningMessage(
    `${commit.date} の版に戻しますか？`,
    { modal: true, detail: lines.join("\n") },
    "戻す"
  );
  return answer === "戻す";
}

/** 名前を出すのは5件まで。長い一覧は確認の妨げになる */
function sample(files: string[]): string {
  const shown = files.slice(0, 5).join("、");
  return files.length > 5 ? `${shown} ほか${files.length - 5}件` : shown;
}
