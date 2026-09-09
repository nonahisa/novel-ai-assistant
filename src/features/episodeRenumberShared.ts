import * as vscode from "vscode";
import type { EpisodeFile, WorkEntry } from "../models/types";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
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
 * 確認ダイアログに出す「何を動かすのか」の内訳（設計書6.67.4）。
 *
 * **どのフォルダーの話が対象なのかを最初に言う。** 番外編や下書きを
 * 別のフォルダーに置いている作品では、「第3話以降を付け替えます」だけでは
 * 番外編の第3話まで動くように読める（実際には動かさない）。
 */
export function describeRenumberTargets(
  work: WorkEntry,
  plan: RenumberPlan
): string {
  const lines = [
    `対象は「${folderLabel(work, plan.folder)}」の話だけです（付け替え${plan.renames.length}件）。`,
  ];
  if (plan.unnumbered.length > 0) {
    // **番号を持たない話が動かないことは、異常ではない**（6.67.2）。
    // 黙っていると「プロローグが取り残された」と読まれる
    lines.push(
      `番号を持たない話（プロローグ・日付名など）${plan.unnumbered.length}件は、そのままです。`
    );
  }
  const skipped = describeSkippedDetail(plan);
  if (skipped) lines.push(skipped);
  return lines.join("\n");
}

/** 作者に見せるフォルダーの呼び名。作品フォルダーの直下ならそう言う */
function folderLabel(work: WorkEntry, folder: string): string {
  const relative = path.relative(work.folderPath, folder);
  if (!relative || relative === ".") return "作品フォルダーの直下";
  return relative.replace(/\\/g, "/");
}

/**
 * 付け替えの対象に、未保存のエディタが開かれていないか（設計書6.67.2）。
 *
 * **開いたまま名前を変えると、あとから保存された未保存の中身が、元の名前で
 * もう一度書き出される**（VS Codeは開いていたパスへ保存する）。話が1つ
 * 増えたように見え、しかもどちらが本物か分からなくなる。始める前に断る。
 *
 * @returns 未保存のまま開かれている話のファイル名
 */
export function findUnsavedEpisodes(filePaths: readonly string[]): string[] {
  const targets = new Set(
    filePaths.map((filePath) => path.normalizeForComparison(filePath))
  );
  return vscode.workspace.textDocuments
    .filter((document) => document.isDirty)
    .map((document) => fromUri(document.uri))
    .filter((filePath) => targets.has(path.normalizeForComparison(filePath)))
    .map((filePath) => path.basename(filePath));
}

/**
 * 実行結果を作者へ伝える（設計書6.67.2・6.67.3）。
 *
 * 1件でも失敗して止まっていれば、**どこまで進んだかを必ず出す**。
 * 台帳への追従が一部失敗していても、原稿の付け替え自体は取り消さない
 * ——そのことが伝わるよう、成功と失敗を分けて書く。
 */
export function reportRenumberOutcome(input: {
  action: "挿入" | "削除";
  pivot: number;
  outcome: RenumberOutcome;
  summary: LedgerFollowSummary;
  /**
   * 付け替えが1件も無かったときに添える理由（「後ろに話が無いため付け替えなし」）。
   *
   * **「付け替える話はありませんでした」だけを出さない。** 末尾の話を
   * 削除したときは付け替えが0件になるが、それでも**話は消えている**。
   * 何も起きなかったように読める文言は、作者を確かめ直しへ走らせる。
   */
  emptyDetail?: string;
}): void {
  const { action, pivot, outcome, summary } = input;
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

  const emptyNote = input.emptyDetail ? `（${input.emptyDetail}）` : "";
  void vscode.window.showInformationMessage(
    outcome.done.length > 0
      ? `第${pivot}話以降、${outcome.done.length}件の話数を付け替えました。${ledgerText}`
      : action === "削除"
        ? `第${pivot}話を削除しました${emptyNote}。${ledgerText}`
        : `第${pivot}話に挿入しました${emptyNote}。${ledgerText}`
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
 *
 * **コミットもパス指定にする。** `git commit -m ...` だけだと、作者が
 * 別の仕事のために index へ載せていたものまで、この「名前を変えただけ」の
 * コミットへ入る。パスを添えれば、そこに挙げたものだけが記録される。
 *
 * **Gitがまだ知らない話は、対ごと外す。** 書いたばかりでまだ一度も
 * 記録していない話は、旧パスが履歴に無いので「改名」になりようがない。
 * 混ぜるとコミット全体が失敗し、動いたはずの付け替えまで記録されない。
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

  const tracked = await trackedRenames(done, root, run);
  const excluded = done.length - tracked.length;
  if (tracked.length === 0) return; // 全部が未追跡なら、コミットの話をしない

  const answer = await vscode.window.showInformationMessage(
    "名前の変更だけを独立したコミットにしますか？",
    {
      modal: true,
      detail:
        "内容を書き換えず、名前だけを変えたコミットにします。" +
        "GitHub上でも「改名」として履歴がつながります。" +
        (excluded > 0
          ? `\nまだ記録していない話が${excluded}件あります。これはこのコミットに入れません（次のいつもの「記録」で入ります）。`
          : ""),
    },
    "コミットする"
  );
  if (answer !== "コミットする") return;

  const paths = tracked.flatMap((rename) => [rename.fromPath, rename.toPath]);
  const added = await run(["add", "--", ...paths], root, LOCAL_TIMEOUT_MS);
  if (added.code !== 0) {
    reportGitFailure("追加", added.stderr || added.stdout);
    return;
  }
  const committed = await run(
    ["commit", "-m", message, "--", ...paths],
    root,
    LOCAL_TIMEOUT_MS
  );
  if (committed.code !== 0) {
    reportGitFailure("記録", committed.stderr || committed.stdout);
    return;
  }
  if (excluded > 0) {
    void vscode.window.showInformationMessage(
      `名前の変更を記録しました。まだGitに記録されていなかった${excluded}件は、このコミットには入れていません。`
    );
  }
}

/**
 * gitが既に知っている（追跡している）旧パスを持つ付け替えだけを残す。
 *
 * 問い合わせは1回にまとめる。`-z` を付けるのは、日本語のファイル名が
 * 引用符付きに化けるのを避けるため（`core.quotepath`）。
 */
async function trackedRenames(
  done: readonly EpisodeRename[],
  root: string,
  run: GitCommandRunner
): Promise<EpisodeRename[]> {
  const result = await run(
    ["ls-files", "-z", "--", ...done.map((rename) => rename.fromPath)],
    root,
    LOCAL_TIMEOUT_MS
  );
  if (result.code !== 0) {
    // 確かめられないときは、これまでどおり全部を対象にする（コミットが
    // 失敗すれば、その理由はそのまま作者へ伝わる）
    logFailure("話数付け替えの独立コミット", {
      段階: "追跡の確認",
      内容: result.stderr || result.stdout,
    });
    return [...done];
  }

  // **区切りのNULは生で書かない**（CLAUDE.md。`sourceHygiene.test.ts` が見る）
  const separator = String.fromCharCode(0);
  const trackedPaths = new Set(
    result.stdout
      .split(separator)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      // ls-files はリポジトリの根からの相対パスを返す
      .map((entry) => path.normalizeForComparison(path.join(root, entry)))
  );
  return done.filter((rename) =>
    trackedPaths.has(path.normalizeForComparison(rename.fromPath))
  );
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
