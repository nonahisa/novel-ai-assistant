import * as vscode from "vscode";
import type { SyncTarget } from "../core/syncTarget";
import { describeIncludedWorks, describeSyncTarget } from "../core/syncTarget";
import { syncCommitMessage } from "../core/syncAllPlan";
import {
  readSyncStatus,
  runGit,
  type GitCommandRunner,
  type GitSyncStatus,
} from "../core/git";
import {
  addRemote,
  commitAll,
  countTrackableFiles,
  createGithubRepositoryWithFreeName,
  rememberGithubCredential,
  currentBranch,
  describeNetworkFailure,
  ensureGithubAuthToken,
  ghAvailable,
  ghCreateRepositoryWithFreeName,
  hasCommitIdentity,
  hasCommits,
  hasGithubSession,
  initRepository,
  pushSetUpstream,
  repositoryDescription,
  setCommitIdentity,
  suggestRepositoryName,
  asciiRepositoryName,
  validateRepositoryUrl,
} from "../core/gitSetup";
import { logFailure, logStep } from "../core/logger";
import { useSyncLog } from "./syncLog";
import { redactUrlCredentials } from "../core/redactUrl";
import { withProgress } from "../views/progress";
import { askText , cancelItem } from "../views/dialogs";
import { confirmRun, notifyDone, warnWithLog } from "../views/notify";

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
          "執筆・文字数・設定資料・あらすじは、Gitが無くてもすべて使えます。",
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
          "作品をGitHubへ送ります。原稿が外部のサービスへ渡ります。" +
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
  target: SyncTarget,
  run: GitCommandRunner = runGit
): Promise<boolean> {
  await useTargetLog(target);
  const count = await countTrackableFiles(target.folderPath, run);
  if (count === 0) {
    vscode.window.showInformationMessage(
      `${target.label} に記録していない変更はありません。`
    );
    return false;
  }

  if (!(await hasCommitIdentity(target.folderPath, run))) {
    if (!(await askCommitIdentity(target, run))) return false;
  }

  const defaultMessage = syncCommitMessage(count, new Date());
  const message = await askText({
    title: "この記録に付ける説明",
    value: defaultMessage,
    prompt: "あとから履歴を辿るときの目印になります",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? "空にはできません。" : undefined,
  });
  if (!message) return false;

  const committed = await commitAll(target.folderPath, message.trim(), run);
  if (!committed.ok) {
    reportFailure("変更の記録", committed.detail);
    return false;
  }
  // 数えてから記録するまでの間に、別の窓が先に記録したときはここへ来る。
  // **失敗として出さない。** 起きたことをそのまま伝える
  if (committed.nothingToCommit) {
    vscode.window.showInformationMessage(
      `${target.label} に記録していない変更はありませんでした。`
    );
    return false;
  }

  logStep(`変更を記録: ${target.label}（${count}件）`);
  vscode.window.showInformationMessage(
    `${count} 件の変更を記録しました。`
  );
  return true;
}

/**
 * 記録の書き先を、その置き場のログへ向ける（0.45.0）。
 *
 * **同期の相手は「置き場」であって作品ではない。** 書庫なら書庫のログへ書く
 * （設計書5.7.9。2026-10-03 までは先頭の作品のログへ紛れていた）。
 * **まだ作品が登録されていない置き場では向けない**——書き先が無いので、
 * その分は出力チャンネルだけに出す（設定の途中にしか起きない）。
 */
async function useTargetLog(target: SyncTarget): Promise<void> {
  await useSyncLog(target.folderPath, target.works);
}

/** 続けて進める段の上限（管理を始める・送り先・送信の3段に、余裕を1つ） */
const MAX_SETUP_STEPS = 4;

/**
 * 「次の一手」を、止まらずに最後まで続けて進める（作者の裁定、2026-10-26）。
 *
 * これまで入口（`novelai.setupGithub`）は押すたびに1手だけ進めて止まり、
 * 作者はメニューを3回押す必要があった。止まった所で「次はGitHubと
 * つなげます」と出るのに進まないので、作者は別の書庫の同期を誤って押した。
 *
 * **1手ごとに状態を読み直してから次を出す**（同じ問いを2度出さないため。
 * 状態が変わらなかったら、そこで止める）。作者が取りやめた段・この端末だけで
 * 使うと決めた段では、その先へ進まない。進んだ段が1つでもあれば true。
 */
export async function runSetupFlow(
  target: SyncTarget,
  firstStatus: GitSyncStatus,
  deps: {
    readStatus?: (cwd: string, run: GitCommandRunner) => Promise<GitSyncStatus>;
    run?: GitCommandRunner;
  } = {}
): Promise<boolean> {
  const readStatus = deps.readStatus ?? readSyncStatus;
  const run = deps.run ?? runGit;
  let status = firstStatus;
  let advancedAny = false;
  for (let i = 0; i < MAX_SETUP_STEPS; i++) {
    if (!nextSetupStep(status)) break;
    if (!(await runSetupStep(target, status, run))) break;
    advancedAny = true;
    const before = status.kind;
    status = await readStatus(target.folderPath, run);
    if (status.kind === before) break;
  }
  return advancedAny;
}

/** 「次の一手」を実行する。進んだら true */
export async function runSetupStep(
  target: SyncTarget,
  status: GitSyncStatus,
  run: GitCommandRunner = runGit
): Promise<boolean> {
  await useTargetLog(target);
  switch (status.kind) {
    case "git_missing":
      await guideGitInstall();
      return false;
    case "not_a_repo":
      return startTracking(target, run);
    case "no_remote":
      return connectRemote(target, run);
    case "no_upstream":
      return firstPush(target, status.branch, run);
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
      "執筆・文字数・設定資料・あらすじ・誤字脱字などは、Gitが無くてもすべて使えます。\n\n" +
      "Windowsなら、ターミナルで次を実行すると入ります。\n" +
      command,
    { modal: true },
    "コマンドをコピー",
    "配布ページを開く"
  );

  if (answer === "コマンドをコピー") {
    await vscode.env.clipboard.writeText(command);
    notifyDone(
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
  target: SyncTarget,
  run: GitCommandRunner
): Promise<boolean> {
  // **何が1つの置き場になるのかを、名前で言う**（設計書5.7.9）。
  // 複数の作品が入る形が既定なので、「作品フォルダーに」とだけ書くと
  // 作品ごとに分かれると読めてしまう
  const scope =
    target.works.length > 1
      ? `「${target.label}」に履歴を作り、中の${target.works.length}作品をまとめて1つ目の記録として残します。\n`
      : "作品フォルダーに履歴を作り、今ある原稿を1つ目の記録として残します。\n";

  /*
    **［始める］と［記録する］を1つの問いにする**（作者の裁定、2026-10-26）。
    以前は「管理しますか」と「N件を記録します」を続けて訊いていた。
    記録の確認が言っていたこと（何を残すか・同期しないものは除く・残した記録は
    消さない）は、この1つの窓の文に残す。**残したものは消さない**（設計書5.5）ので
    警告の顔で訊く（0.35.4）。

    件数はこの窓には出せない——数えるには `git init` が要り、訊く前に init すると
    取りやめても `.git` が残る。件数は記録のあとの知らせへ回した。
  */
  const confirmed = await confirmRun(
    `${describeSyncTarget(target)} をGitで管理しますか？\n` +
      scope +
      "キャッシュなど、同期しない設定のものは除きます。残した記録は、あとから消しません。\n" +
      "この時点ではまだ外部へ何も送りません。",
    "始める",
    { kind: "warning" }
  );
  if (!confirmed) return false;

  const initialized = await initRepository(target.folderPath, run);
  if (!initialized.ok) {
    reportFailure("Gitの初期化", initialized.detail);
    return false;
  }

  // 名前とメールが無いとコミットが失敗する。初めての人はここで必ず詰まる
  if (!(await hasCommitIdentity(target.folderPath, run))) {
    if (!(await askCommitIdentity(target, run))) return false;
  }

  const count = await countTrackableFiles(target.folderPath, run);

  const committed = await commitAll(
    target.folderPath,
    `初回コミット: ${target.label}`,
    run
  );
  if (!committed.ok) {
    reportFailure("初回コミット", committed.detail);
    return false;
  }
  // 1つ目の記録が作れないと、このあとの送信も履歴も成り立たない。
  // **空のフォルダーだったということなので、失敗ではなく理由を出す**
  if (committed.nothingToCommit) {
    vscode.window.showWarningMessage(
      `${target.label} に記録できるものがありませんでした。` +
        "本文を1話でも置いてから、もう一度お試しください。"
    );
    return false;
  }

  logStep(`Gitで管理を開始: ${target.label}（${count}件）`);
  // 次の段（送り先）は `runSetupFlow` が続けて出すので、ここでは止めない
  notifyDone(
    `${target.label} をGitで管理し始めました（${count} 件を記録）。続けてGitHubのリポジトリとつなげます。`
  );
  return true;
}

/** 名前とメールを聞いて、この作品フォルダにだけ設定する */
async function askCommitIdentity(
  target: SyncTarget,
  run: GitCommandRunner
): Promise<boolean> {
  await vscode.window.showInformationMessage(
    "履歴に残す名前とメールアドレスがまだ設定されていません。\n" +
      "この作品フォルダーにだけ設定します（他の作業には影響しません）。",
    { modal: true },
    "入力する"
  );

  const name = await askText({
    title: "履歴に残す名前",
    prompt: "ペンネームでも構いません",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? "名前を入力してください。" : undefined,
  });
  if (!name) return false;

  const email = await askText({
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
    target.folderPath,
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

/**
 * リモートを決める。
 *
 * 新規作成は2通り用意する。VS Codeのアカウントを使う経路は追加インストールが
 * 要らないので最優先で出す。GitHub CLI（gh）は入っていれば選べる代替経路として残す。
 */
async function connectRemote(
  target: SyncTarget,
  run: GitCommandRunner
): Promise<boolean> {
  const canUseGh = await ghAvailable();
  const items: Array<
    vscode.QuickPickItem & { action: "vscodeAuth" | "gh" | "url" | "local" }
  > = [];

  items.push({
    label: "$(github) VS Codeのアカウントで新しく作る",
    description: "非公開（private）・追加インストール不要",
    detail:
      "VS Codeにサインインしている（していなければこれからサインインする）" +
      "GitHubアカウントで新しいリポジトリを作り、送り先として登録します。",
    action: "vscodeAuth",
  });
  if (canUseGh) {
    items.push({
      label: "$(add) GitHub CLIで新しく作る",
      description: "非公開（private）",
      detail:
        "GitHub CLI で新しいリポジトリを作り、送り先として登録します。" +
        "公開したくなったら、あとでGitHubの画面から変えられます。",
      action: "gh",
    });
  }
  items.push({
    label: "$(link) 既にあるリポジトリのURLを指定する",
    description: "",
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

  const picked = await vscode.window.showQuickPick([...items, cancelItem()], {
    title: `${target.label} の送り先`,
    placeHolder: "GitHubへ送るか、この端末だけで使うかを決めます",
    ignoreFocusOut: true,
  });
  if (!picked || !("action" in picked)) return false;

  if (picked.action === "local") {
    // **GitHubを使わないことは正しい選び方である。**
    // アカウントを持たない作者や、原稿を外部へ置きたくない作者がいる。
    // 履歴だけでも「消してしまった原稿を戻す」という価値がある
    vscode.window.showInformationMessage(
      `${target.label} は、この端末だけで履歴を残します。\n` +
        // 一覧の項目名に合わせる（作者の裁定「案A」、2026-10-13 夜）
        "書き換えを残したいときは「GitHubと同期」の「いまの原稿を履歴に残す」を押してください。"
    );
    return false;
  }

  if (picked.action === "vscodeAuth" || picked.action === "gh") {
    return createAndSend(target, picked.action, run);
  }

  const url = await askText({
    title: "リポジトリのURL",
    prompt: "https://github.com/ユーザー名/リポジトリ名.git",
    ignoreFocusOut: true,
    validateInput: validateRepositoryUrl,
  });
  if (!url) return false;

  const added = await addRemote(target.folderPath, url.trim(), run);
  if (!added.ok) {
    reportFailure("送り先の登録", added.detail);
    return false;
  }
  logStep(`送り先を登録: ${url.trim()}`);
  notifyDone("送り先を登録しました。");
  return true;
}

/**
 * 新しくリポジトリを作り、そのまま1回目を送る（作者の裁定、2026-10-26）。
 *
 * **作る確認と送る確認を1つにまとめる。送る前の確認そのものは残す**（設計書5.5.9）。
 * 以前は名前の入力 → 作成 →（もう一度押して）［送信する］と分かれていた。
 * 作るのは送るためなので、作者にとっては1つの判断である。
 *
 * - **名前は訊かない**（`suggestRepositoryName`。日本語の題は説明欄へ）。同じ名前が
 *   あれば `-2` … で作るので、確認の文にもそう書き、作った名前は知らせで言う
 * - VS Code のアカウントの道で、まだ repo の権限のサインインが無ければ、
 *   このあと出る VS Code の［許可］とブラウザの［Authorize］を確認の中で前置きする
 *   （この2つは VS Code と GitHub の問いで、こちらからは消せない）
 * - **確認はモーダルのまま**（5.5.9「送信の前には…確認を取る（モーダル）」）
 */
async function createAndSend(
  target: SyncTarget,
  via: "vscodeAuth" | "gh",
  run: GitCommandRunner
): Promise<boolean> {
  if (!(await hasCommits(target.folderPath, run))) {
    vscode.window.showWarningMessage(
      "まだ記録が1つもありません。先に「Gitで管理を始める」を実行してください。"
    );
    return false;
  }

  const name = suggestRepositoryName(target.label);
  const description = repositoryDescription(target.label);
  const needsSignIn = via === "vscodeAuth" && !(await hasGithubSession());

  const included = describeIncludedWorks(target);
  const detailLines = [
    ...(included ? [included] : []),
    "原稿と設定資料が外部のサービスへ渡ります。",
    // 日付の名前になったかは、題から英数字の名前が作れたかで見る
    // （「My Novel 2」は My-Novel-2 になり、題とは一致しないので比べない）
    asciiRepositoryName(target.label) !== ""
      ? "同じ名前のリポジトリが既にあれば、末尾に -2 などの番号を足して作ります。"
      : `GitHubのリポジトリ名には日本語を使えないため、日付で名前を付け、題「${description}」は説明欄に入れます。` +
        "同じ名前が既にあれば、末尾に -2 などの番号を足して作ります。",
    ...(needsSignIn
      ? [
          "次に VS Code の許可と、ブラウザで GitHub の承認を求められます。" +
            "どちらも［許可］／［Authorize］を押してください。",
        ]
      : []),
  ];
  const sendLabel = "作って送る";
  const confirm = await vscode.window.showWarningMessage(
    `非公開のリポジトリ ${name} をGitHubに作り、${describeSyncTarget(target)} を送ります。`,
    { modal: true, detail: detailLines.join("\n\n") },
    sendLabel
  );
  if (confirm !== sendLabel) return false;

  const created =
    via === "vscodeAuth"
      ? await createViaVscodeAccount(target, name, description, run)
      : await createViaGh(target, name, description, run);
  if (!created) return false;

  const branch = await currentBranch(target.folderPath, run);
  const sent = await sendFirst(target, branch, created.url, run);
  if (!sent) return false;

  vscode.window.showInformationMessage(
    `非公開のリポジトリ ${created.name} を作り、${target.label} を GitHub へ送りました。` +
      // 一覧の項目名に合わせる（作者の裁定「案A」、2026-10-13 夜）
      "以後は「GitHubと同期」で GitHub とそろえられます。" +
      (created.remembered === false
        // 送り終えたあとの知らせなので、「次の送信」と言う（今回の送信は済んでいる）
        ? "（この端末では認証情報を覚えられませんでした。次の送信で Git から一度聞かれることがあります）"
        : "")
  );
  return true;
}

/**
 * VS Code本体のGitHubアカウントでリポジトリを作る（`gh`コマンド不要）。
 *
 * トークンの取得はブラウザでの見慣れた承認画面になる。
 * 作成したリポジトリのURLは、ここで`git remote add`まで行う
 * （ghと違い、API呼び出し自体はリモート登録まで面倒を見てくれないため）。
 */
async function createViaVscodeAccount(
  target: SyncTarget,
  name: string,
  description: string,
  run: GitCommandRunner
): Promise<{ name: string; url: string; remembered: boolean } | undefined> {
  const token = await withProgress("GitHubへサインインしています", () =>
    ensureGithubAuthToken()
  );
  if (!token) {
    vscode.window.showWarningMessage(
      "GitHubへのサインインが完了しなかったため、作成を中止しました。"
    );
    return undefined;
  }

  const created = await withProgress("リポジトリを作っています", () =>
    createGithubRepositoryWithFreeName(token, name, description)
  );
  if (!created.ok || !created.cloneUrl) {
    reportFailure("リポジトリの作成", created.detail);
    return undefined;
  }
  const createdName = created.name ?? name;

  const added = await addRemote(target.folderPath, created.cloneUrl, run);
  if (!added.ok) {
    reportFailure("送り先の登録", added.detail);
    return undefined;
  }

  // **鍵をgit側にも覚えさせる**（設計書5.5.12）。これをしないと、
  // 「VS Codeのアカウントを使う」と答えたのに、送信でまた聞かれる
  // （リポジトリを作るのはAPI、送るのは別プロセスの git であるため）
  const remembered = await rememberGithubCredential(
    token,
    created.cloneUrl,
    target.folderPath
  );
  logStep(
    `GitHubにリポジトリを作成（VS Codeアカウント）: ${createdName}（private）` +
      `／認証情報の記憶: ${remembered ? "成功" : "できず"}`
  );

  /*
    **非公開で作られたと GitHub が答えたときだけ、そのまま送る。**
    以前は送る前の確認で「非公開かどうかをGitHubの画面で確かめて」と作者に
    頼んでいた。作成の確認と送信の確認を1つにまとめたので、確かめるのは
    こちらが応答で行う。答えが無い・違うときは送らずに止める（送り先は登録済み
    なので、作者が GitHub の画面で確かめてから「はじめて送信する」で送れる）
  */
  if (created.isPrivate !== true) {
    logFailure("リポジトリの作成", {
      内容: `非公開で作られたことを確かめられなかったため送信を止めた: ${createdName}`,
    });
    void warnWithLog(
      `リポジトリ ${createdName} が非公開で作られたことを確かめられなかったため、送らずに止めました。` +
        "GitHubの画面で非公開になっているかを確かめてから、もう一度「GitHub初期設定」を押してください。"
    );
    return undefined;
  }

  return { name: createdName, url: created.cloneUrl, remembered };
}

/** GitHub CLI（gh）でリポジトリを作る。remoteの登録もgh側で完結する */
async function createViaGh(
  target: SyncTarget,
  name: string,
  description: string,
  run: GitCommandRunner
): Promise<{ name: string; url: string; remembered?: boolean } | undefined> {
  const created = await withProgress("リポジトリを作っています", () =>
    ghCreateRepositoryWithFreeName(target.folderPath, name, description)
  );
  if (!created.ok) {
    reportFailure("リポジトリの作成", created.detail);
    return undefined;
  }
  const createdName = created.name ?? name;
  logStep(`GitHubにリポジトリを作成: ${createdName}（private）`);
  // gh の道は `--private` を必ず付けて作り、送り先も gh が登録する。
  // 記録に残す送り先は、gh が登録したものを読む
  const remote = await run(["remote", "get-url", "origin"], target.folderPath, 15_000);
  return { name: createdName, url: remote.stdout.trim() || createdName };
}

/** はじめての送信。原稿が外部へ渡ることを明示して確認する */
async function firstPush(
  target: SyncTarget,
  branch: string,
  run: GitCommandRunner
): Promise<boolean> {
  if (!(await hasCommits(target.folderPath, run))) {
    vscode.window.showWarningMessage(
      "まだ記録が1つもありません。先に「Gitで管理を始める」を実行してください。"
    );
    return false;
  }

  const remote = await run(
    ["remote", "get-url", "origin"],
    target.folderPath,
    15_000
  );
  // 古い作品フォルダーには、URLに鍵を埋め込んだ送り先が残っていることがある
  // （いまは登録時に断っている）。**画面にもログにも鍵を出さない**
  const remoteUrl =
    redactUrlCredentials(remote.stdout.trim()) ||
    "（送り先が取得できませんでした）";

  // **何作品ぶんが出ていくのかを、送る前に言う**（文言は `syncTarget.ts`）
  const included = describeIncludedWorks(target);
  const scope = included ? `\n${included}` : "";

  // ここへ来るのは、送り先を URL で登録した（自分で作ったリポジトリ）ときと、
  // 作ったあとの送信が途中で止まったとき。どちらもこちらが非公開を確かめて
  // いないので、確かめてもらう一文は残す
  const confirm = await vscode.window.showWarningMessage(
    `${describeSyncTarget(target)} をGitHubへ送ります。\n\n` +
      `送り先: ${remoteUrl}${scope}\n\n` +
      "原稿と設定資料が外部のサービスへ渡ります。 " +
      "送り先が非公開かどうかを、GitHubの画面で確かめてから実行してください。",
    { modal: true },
    "送信する"
  );
  if (confirm !== "送信する") return false;

  if (!(await sendFirst(target, branch, remoteUrl, run))) return false;
  vscode.window.showInformationMessage(
    // 一覧の項目名に合わせる（作者の裁定「案A」、2026-10-13 夜）
    `${target.label} を GitHub へ送りました。以後は「GitHubと同期」で GitHub とそろえられます。`
  );
  return true;
}

/**
 * 1回目の送信の本体（確認は呼ぶ側が済ませている）。
 *
 * 確認の出し方が2通り（作って送る／登録済みの送り先へ送る）になったので、
 * 送る所だけを1つにしておく。
 */
async function sendFirst(
  target: SyncTarget,
  branch: string,
  remoteLabel: string,
  run: GitCommandRunner
): Promise<boolean> {
  const result = await withProgress("GitHubへ送信しています", () =>
    pushSetUpstream(target.folderPath, branch, run)
  );
  if (!result.ok) {
    reportFailure("送信", result.detail);
    return false;
  }
  logStep(`はじめての送信: ${target.label} → ${redactUrlCredentials(remoteLabel)}（${branch}）`);
  return true;
}

function reportFailure(context: string, detail: string | undefined): void {
  // ログには生の理由をそのまま残す。言い換えたものだけでは原因を追えない
  logFailure(context, { 内容: detail ?? "（詳細なし）" });

  // つながらないだけなのか、設定が違うのかで、作者が次にやることが変わる
  const translated = describeNetworkFailure(detail);
  void warnWithLog(
    translated
      ? `${context}に失敗しました。\n${translated}`
      : `${context}に失敗しました。${detail ? `\n${detail.slice(0, 200)}` : ""}`
  );
}

/** 現在のブランチ名を知りたい呼び出し元のために公開する */
export { currentBranch };
