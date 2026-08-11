import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { runGit, type GitCommandRunner, type GitSyncStatus } from "../core/git";
import {
  addRemote,
  commitAll,
  countTrackableFiles,
  currentBranch,
  describeNetworkFailure,
  ghAvailable,
  ghCreateRepository,
  hasCommitIdentity,
  hasCommits,
  initRepository,
  pushSetUpstream,
  setCommitIdentity,
  suggestRepositoryName,
  validateRepositoryUrl,
} from "../core/gitSetup";
import { logFailure, logStep, showLog } from "../core/logger";
import { withProgress } from "../views/progress";

/**
 * GitHub同期を始めるまでの案内。
 *
 * これまでは「リポジトリではありません」「リモートが設定されていません」と
 * **状態を伝えるだけ**で、そこから抜け出す操作が無かった。
 * 作者はプログラマではないため、ここで手が止まると同期機能に一生触れない。
 *
 * **原稿を外部サービスへ渡す操作**なので、送信の前には必ず確認を挟み、
 * 新しく作るリポジトリは private に固定する。
 */

/** 状態に応じて「次の一手」を返す。何もすることが無ければ undefined */
export function nextSetupStep(
  status: GitSyncStatus
): { label: string; description: string; detail: string } | undefined {
  switch (status.kind) {
    case "git_missing":
      return {
        label: "$(question) Gitを導入するには",
        description: "同期を使わないなら不要",
        detail:
          "履歴と同期にはGitが要ります。導入の方法を案内します。" +
          "**執筆・文字数・設定資料・あらすじは、Gitが無くてもすべて使えます。**",
      };
    case "not_a_repo":
      return {
        label: "$(repo) Gitで管理を始める",
        description: "履歴を残せるようにする",
        detail:
          "作品フォルダーで git init を行い、今ある原稿を1つ目の履歴として記録します。" +
          "この時点ではまだ外部へ何も送りません。",
      };
    case "no_remote":
      return {
        label: "$(github) GitHubのリポジトリとつなぐ",
        description: "送り先を決める",
        detail:
          "新しいリポジトリを作るか、既にあるリポジトリのURLを指定します。" +
          "新しく作る場合は必ず非公開（private）にします。",
      };
    case "no_upstream":
      return {
        label: "$(cloud-upload) はじめて送信する",
        description: `${status.branch} をGitHubへ`,
        detail:
          "作品をGitHubへ送ります。**原稿が外部のサービスへ渡ります。**" +
          "送る前に件数と送り先を確認します。",
      };
    default:
      return undefined;
  }
}

/**
 * 「変更を記録する」を出してよい状態か。
 *
 * リポジトリになっていれば、送り先の有無にかかわらず記録できる。
 * **GitHubを使わない作者にとっては、これが唯一の使い道**である。
 */
export function canRecordChanges(status: GitSyncStatus): boolean {
  return (
    status.kind === "tracked" ||
    status.kind === "no_remote" ||
    status.kind === "no_upstream"
  );
}

/**
 * いまの変更を履歴に残す（コミット）。
 *
 * **これが無いと、初回コミットのあと何も記録できない。**
 * 送信（push）は記録済みのものを送る操作なので、記録する手段が無いままでは
 * 同期そのものが動かない。
 *
 * メッセージはAIに書かせず、日付と件数で作る（P-14は未実装）。
 * 記録のたびにAIを呼ぶと、料金が執筆の回数に比例してかかる。
 */
export async function recordChanges(
  work: WorkEntry,
  run: GitCommandRunner = runGit
): Promise<boolean> {
  const count = await countTrackableFiles(work.folderPath, run);
  if (count === 0) {
    vscode.window.showInformationMessage(
      `${work.title} に記録していない変更はありません。`
    );
    return false;
  }

  if (!(await hasCommitIdentity(work.folderPath, run))) {
    if (!(await askCommitIdentity(work, run))) return false;
  }

  const defaultMessage = `${formatStamp(new Date())} の執筆（${count}件）`;
  const message = await vscode.window.showInputBox({
    title: "この記録に付ける説明",
    value: defaultMessage,
    prompt: "あとから履歴を辿るときの目印になります",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? "空にはできません。" : undefined,
  });
  if (!message) return false;

  const committed = await commitAll(work.folderPath, message.trim(), run);
  if (!committed.ok) {
    reportFailure("変更の記録", committed.detail);
    return false;
  }

  logStep(`変更を記録: ${work.title}（${count}件）`);
  vscode.window.showInformationMessage(
    `${count} 件の変更を記録しました。`
  );
  return true;
}

/** 履歴の説明に使う日時。ログと同じく端末の時刻で書く */
function formatStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

/** 「次の一手」を実行する。進んだら true */
export async function runSetupStep(
  work: WorkEntry,
  status: GitSyncStatus,
  run: GitCommandRunner = runGit
): Promise<boolean> {
  switch (status.kind) {
    case "git_missing":
      await guideGitInstall();
      return false;
    case "not_a_repo":
      return startTracking(work, run);
    case "no_remote":
      return connectRemote(work, run);
    case "no_upstream":
      return firstPush(work, status.branch, run);
    default:
      return false;
  }
}

/**
 * Gitの導入を案内する。
 *
 * **勝手にインストールしない。** 環境を変える操作であり、
 * 管理者の権限が要ることもある。決めるのは作者である。
 *
 * あわせて「無くても困らない」ことを伝える。Gitは執筆に必須ではないのに、
 * 見つからない旨だけを出していると、必要なものが欠けていると誤解させる。
 */
async function guideGitInstall(): Promise<void> {
  const command = "winget install --id Git.Git -e";
  const answer = await vscode.window.showInformationMessage(
    "Gitが見つかりません。\n\n" +
      "履歴を残すこと（書き直す前へ戻す）と、複数の環境で同期することにGitを使います。\n" +
      "**執筆・文字数・設定資料・あらすじ・誤字脱字などは、Gitが無くてもすべて使えます。**\n\n" +
      "Windowsなら、ターミナルで次を実行すると入ります。\n" +
      command,
    { modal: true },
    "コマンドをコピー",
    "配布ページを開く"
  );

  if (answer === "コマンドをコピー") {
    await vscode.env.clipboard.writeText(command);
    vscode.window.showInformationMessage(
      "コピーしました。ターミナルに貼り付けて実行してください。" +
        "導入後はVS Codeを開き直すと認識されます。"
    );
    return;
  }
  if (answer === "配布ページを開く") {
    await vscode.env.openExternal(vscode.Uri.parse("https://git-scm.com/downloads"));
  }
}

/** git init と初回コミット。ここでは外部へ何も送らない */
async function startTracking(
  work: WorkEntry,
  run: GitCommandRunner
): Promise<boolean> {
  const answer = await vscode.window.showInformationMessage(
    `${work.title} をGitで管理しますか？\n` +
      "作品フォルダーに履歴を作り、今ある原稿を1つ目の記録として残します。\n" +
      "この時点ではまだ外部へ何も送りません。",
    "始める",
    "やめる"
  );
  if (answer !== "始める") return false;

  const initialized = await initRepository(work.folderPath, run);
  if (!initialized.ok) {
    reportFailure("Gitの初期化", initialized.detail);
    return false;
  }

  // 名前とメールが無いとコミットが失敗する。初めての人はここで必ず詰まる
  if (!(await hasCommitIdentity(work.folderPath, run))) {
    if (!(await askCommitIdentity(work, run))) return false;
  }

  const count = await countTrackableFiles(work.folderPath, run);
  const confirm = await vscode.window.showInformationMessage(
    `${count} 件のファイルを1つ目の記録として残します。\n` +
      "（キャッシュなど、同期しない設定のものは除いています）",
    "記録する",
    "やめる"
  );
  if (confirm !== "記録する") return false;

  const committed = await commitAll(
    work.folderPath,
    `初回コミット: ${work.title}`,
    run
  );
  if (!committed.ok) {
    reportFailure("初回コミット", committed.detail);
    return false;
  }

  logStep(`Gitで管理を開始: ${work.title}（${count}件）`);
  vscode.window.showInformationMessage(
    `${work.title} をGitで管理し始めました。次はGitHubのリポジトリとつなげます。`
  );
  return true;
}

/** 名前とメールを聞いて、この作品フォルダにだけ設定する */
async function askCommitIdentity(
  work: WorkEntry,
  run: GitCommandRunner
): Promise<boolean> {
  await vscode.window.showInformationMessage(
    "履歴に残す名前とメールアドレスがまだ設定されていません。\n" +
      "この作品フォルダーにだけ設定します（他の作業には影響しません）。",
    { modal: true },
    "入力する"
  );

  const name = await vscode.window.showInputBox({
    title: "履歴に残す名前",
    prompt: "ペンネームでも構いません",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? "名前を入力してください。" : undefined,
  });
  if (!name) return false;

  const email = await vscode.window.showInputBox({
    title: "履歴に残すメールアドレス",
    prompt: "GitHubに登録しているものを推奨します",
    ignoreFocusOut: true,
    validateInput: (value) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
        ? undefined
        : "メールアドレスの形で入力してください。",
  });
  if (!email) return false;

  const result = await setCommitIdentity(
    work.folderPath,
    name.trim(),
    email.trim(),
    run
  );
  if (!result.ok) {
    reportFailure("名前とメールの設定", result.detail);
    return false;
  }
  return true;
}

/** リモートを決める。ghがあれば新規作成、無ければURLを貼ってもらう */
async function connectRemote(
  work: WorkEntry,
  run: GitCommandRunner
): Promise<boolean> {
  const canUseGh = await ghAvailable();
  const items: Array<
    vscode.QuickPickItem & { action: "gh" | "url" | "local" }
  > = [];
  if (canUseGh) {
    items.push({
      label: "$(add) 新しいリポジトリを作る",
      description: "非公開（private）",
      detail:
        "GitHub CLI で新しいリポジトリを作り、送り先として登録します。" +
        "公開したくなったら、あとでGitHubの画面から変えられます。",
      action: "gh",
    });
  }
  items.push({
    label: "$(link) 既にあるリポジトリのURLを指定する",
    description: canUseGh ? "" : "GitHubの画面で作ってから貼り付け",
    detail:
      "GitHubで作ったリポジトリのURL（https://github.com/… ）を貼り付けます。",
    action: "url",
  });
  items.push({
    label: "$(device-desktop) このままこの端末だけで使う",
    description: "GitHubのアカウントは要りません",
    detail:
      "送り先を決めずに、この端末の中だけで履歴を残します。" +
      "書き直す前の原稿へ戻せるので、これだけでも役に立ちます。" +
      "あとからGitHubへつなぐこともできます。",
    action: "local",
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `${work.title} の送り先`,
    placeHolder: "GitHubへ送るか、この端末だけで使うかを決めます",
    ignoreFocusOut: true,
  });
  if (!picked) return false;

  if (picked.action === "local") {
    // **GitHubを使わないことは正しい選び方である。**
    // アカウントを持たない作者や、原稿を外部へ置きたくない作者がいる。
    // 履歴だけでも「消してしまった原稿を戻す」という価値がある
    vscode.window.showInformationMessage(
      `${work.title} は、この端末だけで履歴を残します。\n` +
        "変更を残したいときは「変更を記録する」を実行してください。"
    );
    return false;
  }

  if (picked.action === "gh") {
    const suggested = suggestRepositoryName(work.title);
    const name = await vscode.window.showInputBox({
      title: "新しいリポジトリの名前",
      // 日本語の作品名からは作れないので、その場合は空欄から入力してもらう
      value: suggested,
      prompt: "英数字と - _ . が使えます",
      ignoreFocusOut: true,
      validateInput: (value) =>
        /^[A-Za-z0-9._-]+$/.test(value.trim())
          ? undefined
          : "英数字と - _ . だけが使えます。",
    });
    if (!name) return false;

    const created = await withProgress("リポジトリを作っています", () =>
      ghCreateRepository(work.folderPath, name.trim())
    );
    if (!created.ok) {
      reportFailure("リポジトリの作成", created.detail);
      return false;
    }
    logStep(`GitHubにリポジトリを作成: ${name.trim()}（private）`);
    vscode.window.showInformationMessage(
      `非公開のリポジトリ ${name.trim()} を作り、送り先に設定しました。`
    );
    return true;
  }

  const url = await vscode.window.showInputBox({
    title: "リポジトリのURL",
    prompt: "https://github.com/ユーザー名/リポジトリ名.git",
    ignoreFocusOut: true,
    validateInput: validateRepositoryUrl,
  });
  if (!url) return false;

  const added = await addRemote(work.folderPath, url.trim(), run);
  if (!added.ok) {
    reportFailure("送り先の登録", added.detail);
    return false;
  }
  logStep(`送り先を登録: ${url.trim()}`);
  vscode.window.showInformationMessage("送り先を登録しました。");
  return true;
}

/** はじめての送信。原稿が外部へ渡ることを明示して確認する */
async function firstPush(
  work: WorkEntry,
  branch: string,
  run: GitCommandRunner
): Promise<boolean> {
  if (!(await hasCommits(work.folderPath, run))) {
    vscode.window.showWarningMessage(
      "まだ記録が1つもありません。先に「Gitで管理を始める」を実行してください。"
    );
    return false;
  }

  const remote = await run(
    ["remote", "get-url", "origin"],
    work.folderPath,
    15_000
  );
  const target = remote.stdout.trim() || "（送り先が取得できませんでした）";

  const confirm = await vscode.window.showWarningMessage(
    `${work.title} をGitHubへ送ります。\n\n` +
      `送り先: ${target}\n\n` +
      "**原稿と設定資料が外部のサービスへ渡ります。** " +
      "送り先が非公開かどうかを、GitHubの画面で確かめてから実行してください。",
    { modal: true },
    "送信する"
  );
  if (confirm !== "送信する") return false;

  const result = await withProgress("GitHubへ送信しています", () =>
    pushSetUpstream(work.folderPath, branch, run)
  );
  if (!result.ok) {
    reportFailure("送信", result.detail);
    return false;
  }

  logStep(`はじめての送信: ${work.title} → ${target}（${branch}）`);
  vscode.window.showInformationMessage(
    `${work.title} を送信しました。以後は「取り込む」「送信する」が使えます。`
  );
  return true;
}

function reportFailure(context: string, detail: string | undefined): void {
  // ログには生の理由をそのまま残す。言い換えたものだけでは原因を追えない
  logFailure(context, { 内容: detail ?? "（詳細なし）" });

  // つながらないだけなのか、設定が違うのかで、作者が次にやることが変わる
  const translated = describeNetworkFailure(detail);
  vscode.window
    .showWarningMessage(
      translated
        ? `${context}に失敗しました。\n${translated}`
        : `${context}に失敗しました。${detail ? `\n${detail.slice(0, 200)}` : ""}`,
      "ログを見る"
    )
    .then((answer) => {
      if (answer === "ログを見る") showLog();
    });
}

/** 現在のブランチ名を知りたい呼び出し元のために公開する */
export { currentBranch };
