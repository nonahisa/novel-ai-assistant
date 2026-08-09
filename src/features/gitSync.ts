import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import {
  fetchRemote,
  pullFastForward,
  push,
  readSyncStatus,
  type GitCommandRunner,
  type GitSyncStatus,
} from "../core/git";
import { logFailure, showLog } from "../core/logger";
import { withProgress } from "../views/progress";

/**
 * GitHub同期の見張り（設計書3.5.1）。
 *
 * 競合は「二人の意見がぶつかった」のではなく「同期を忘れて二重に書いた」
 * 事故なので、正しい対応は解決ではなく**予防**である。
 * 分岐が起きるのは「pullせずに書き始めた瞬間」なので、書く前に気づかせる。
 *
 * **自動で走るのは fetch だけ**（取得のみでローカルを変更しない）。
 * 取り込みと送信は必ず作者がボタンを押したときに実行する。
 * 自動pullは執筆中の原稿を巻き込みうるし、自動pushは書きかけの文章を
 * 外部へ送ってしまう。どちらも取り消しにくい。
 */

/** 自動fetchの最小間隔の既定値（分） */
const DEFAULT_AUTO_FETCH_INTERVAL_MINUTES = 10;

export interface GitSyncOptions {
  /** テスト用。実際のgit実行を差し替える */
  run?: GitCommandRunner;
}

export class GitSyncMonitor implements vscode.Disposable {
  private readonly statuses = new Map<string, GitSyncStatus>();
  private readonly lastFetchAt = new Map<string, number>();
  /** 未取得を知らせた作品。同じ通知を何度も出さない */
  private readonly notified = new Set<string>();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();

  /** 状態が変わったとき。ツリーの作り直しに使う */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly registry: WorkRegistry,
    private readonly options: GitSyncOptions = {}
  ) {
    // 設計書は「エディタ上部に警告バーを常時表示」としているが、
    // 拡張機能からエディタ上部へバーを出すAPIは無い。
    // 通知は消えてしまうので、消えずに残る場所としてステータスバーを使う
    // （進捗表示を通知からステータスバーへ移したのと同じ理由）。
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      101
    );
    this.statusBar.command = "novelai.gitSync";
    this.disposables.push(this.statusBar);

    // 本文を開いた時点で、その作品の状態を確かめる。
    // 「書き始める前」に気づかせるのが目的なので、開いた瞬間に見る
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        const work = this.findWork(editor.document.uri.fsPath);
        if (!work) return;
        void this.refresh(work, { fetch: true, notify: true });
      })
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.changed.dispose();
  }

  statusFor(workId: string): GitSyncStatus | undefined {
    return this.statuses.get(workId);
  }

  /** 起動時に全作品を一度確かめる */
  async refreshAll(options: { fetch: boolean }): Promise<void> {
    for (const work of this.registry.list()) {
      await this.refresh(work, { fetch: options.fetch, notify: false });
    }
  }

  /**
   * 1作品の状態を更新する。
   *
   * `fetch` を立てても、間隔を空けずに何度も取りには行かない。
   * エディタを切り替えるたびにネットワークへ出ると、
   * 回線の遅い環境で操作が重くなる。
   */
  async refresh(
    work: WorkEntry,
    options: { fetch: boolean; notify: boolean }
  ): Promise<GitSyncStatus> {
    if (options.fetch && this.shouldAutoFetch(work)) {
      this.lastFetchAt.set(work.id, Date.now());
      const result = await fetchRemote(work.folderPath, this.options.run);
      if (!result.ok) {
        // オフラインでの執筆は普通にあるので、失敗しても通知しない。
        // ただし黙って消すと原因にたどり着けないためログには残す
        logFailure("Gitのfetchに失敗", {
          作品: work.title,
          詳細: result.detail ?? "（詳細なし）",
        });
      }
    }

    const status = await readSyncStatus(work.folderPath, this.options.run);
    this.statuses.set(work.id, status);
    this.updateStatusBar();
    this.changed.fire();

    if (options.notify) await this.notifyIfBehind(work, status);
    return status;
  }

  /** 自動fetchしてよいか。設定と最小間隔で決める */
  private shouldAutoFetch(work: WorkEntry): boolean {
    const config = vscode.workspace.getConfiguration("novelai");
    if (!config.get<boolean>("git.autoFetch", true)) return false;

    const configured = config.get<number>(
      "git.autoFetchIntervalMinutes",
      DEFAULT_AUTO_FETCH_INTERVAL_MINUTES
    );
    // 0や負値を渡されても毎回取りに行かせない。
    // 設定の誤りで回線を叩き続ける状態を作らないため
    const minutes =
      Number.isFinite(configured) && configured >= 1
        ? configured
        : DEFAULT_AUTO_FETCH_INTERVAL_MINUTES;

    const last = this.lastFetchAt.get(work.id);
    if (last === undefined) return true;
    return Date.now() - last >= minutes * 60_000;
  }

  /**
   * 未取得があれば知らせる。
   *
   * 同じ作品について繰り返し出さない。エディタを切り替えるたびに
   * 同じ通知が出ると、読まずに閉じる癖がついて意味を失う。
   * 取り込めば印を消すので、次に遅れたときはまた出る。
   */
  private async notifyIfBehind(
    work: WorkEntry,
    status: GitSyncStatus
  ): Promise<void> {
    if (status.kind !== "tracked" || status.behind === 0) {
      this.notified.delete(work.id);
      return;
    }
    if (this.notified.has(work.id)) return;
    this.notified.add(work.id);

    const action = await vscode.window.showWarningMessage(
      `「${work.title}」に別の環境での変更が未取得です（${status.behind}件）。` +
        "取り込んでから執筆することをおすすめします。",
      "取り込む",
      "このまま開く"
    );
    if (action === "取り込む") await this.pull(work);
  }

  /** 取り込む（作者の操作が起点） */
  async pull(work: WorkEntry): Promise<boolean> {
    const result = await withProgress("別の環境の変更を取り込んでいます…", () =>
      pullFastForward(work.folderPath, this.options.run)
    );

    if (result.ok) {
      this.notified.delete(work.id);
      await this.refresh(work, { fetch: false, notify: false });
      vscode.window.showInformationMessage(
        `「${work.title}」に別の環境の変更を取り込みました。`
      );
      return true;
    }

    if (result.failure.kind === "dirty") {
      vscode.window.showWarningMessage(
        `「${work.title}」に未コミットの変更があるため取り込みませんでした。` +
          "書きかけの原稿を巻き込まないためです。" +
          "変更をコミットするか元に戻してから、もう一度実行してください。"
      );
      return false;
    }

    if (result.failure.kind === "diverged") {
      vscode.window.showWarningMessage(
        `「${work.title}」は、この環境と別の環境の両方で変更が進んでいます。` +
          "どちらを残すかは自動では決められないため、取り込みを中止しました。" +
          "Gitのクライアントで内容を見比べてから解決してください。"
      );
      return false;
    }

    logFailure("Gitの取り込みに失敗", {
      作品: work.title,
      詳細: result.failure.detail,
    });
    const action = await vscode.window.showErrorMessage(
      `「${work.title}」の取り込みに失敗しました。`,
      "ログを表示",
      "閉じる"
    );
    if (action === "ログを表示") showLog();
    return false;
  }

  /** 送信する（作者の操作が起点） */
  async push(work: WorkEntry): Promise<boolean> {
    const status =
      this.statuses.get(work.id) ??
      (await this.refresh(work, { fetch: false, notify: false }));
    if (status.kind !== "tracked") return false;

    // 送信は外部（GitHub）へ出る操作なので、件数を見せてから確認する
    const confirm = await vscode.window.showInformationMessage(
      `「${work.title}」のコミット ${status.ahead} 件を ${status.upstream} へ送信します。`,
      "送信する",
      "中止"
    );
    if (confirm !== "送信する") return false;

    const result = await withProgress("この環境の変更を送信しています…", () =>
      push(work.folderPath, this.options.run)
    );
    if (result.ok) {
      await this.refresh(work, { fetch: false, notify: false });
      vscode.window.showInformationMessage(
        `「${work.title}」の変更を送信しました。`
      );
      return true;
    }

    logFailure("Gitの送信に失敗", {
      作品: work.title,
      詳細: result.detail ?? "（詳細なし）",
    });
    const action = await vscode.window.showErrorMessage(
      `「${work.title}」の送信に失敗しました。` +
        "別の環境の変更が先に送られている場合は、先に取り込んでください。",
      "ログを表示",
      "閉じる"
    );
    if (action === "ログを表示") showLog();
    return false;
  }

  /**
   * ステータスバーの表示を作り直す。
   *
   * **同期が取れているときは何も出さない。** 常に出していると、
   * 出ていること自体が普通になり、警告として働かなくなる。
   */
  private updateStatusBar(): void {
    const warnings = this.registry
      .list()
      .map((work) => ({ work, status: this.statuses.get(work.id) }))
      .filter(
        (entry): entry is { work: WorkEntry; status: GitSyncStatus } =>
          entry.status !== undefined
      )
      .filter(({ status }) => isWarning(status));

    if (warnings.length === 0) {
      this.statusBar.hide();
      return;
    }

    const behind = sumTracked(warnings, (status) => status.behind);
    const ahead = sumTracked(warnings, (status) => status.ahead);
    const unmerged = sumTracked(warnings, (status) => status.unmerged);

    const parts: string[] = [];
    if (behind > 0) parts.push(`未取得 ${behind}`);
    if (ahead > 0) parts.push(`未送信 ${ahead}`);
    if (unmerged > 0) parts.push(`競合 ${unmerged}`);

    this.statusBar.text = `$(git-branch) ${parts.join(" / ")}`;
    this.statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.statusBar.tooltip = new vscode.MarkdownString(
      [
        "**GitHubとの同期**",
        "",
        ...warnings.map(({ work, status }) => describeForTooltip(work, status)),
        "",
        "押すと操作を選べます。",
      ].join("\n")
    );
    this.statusBar.show();
  }

  /** 開いているファイルが属する作品を探す */
  private findWork(filePath: string): WorkEntry | undefined {
    // 深い作品フォルダを先に見て、入れ子の場合に内側を選ぶ
    return [...this.registry.list()]
      .sort((a, b) => b.folderPath.length - a.folderPath.length)
      .find((work) => isPathInside(work.folderPath, filePath));
  }
}

/** 警告として出すべき状態か */
export function isWarning(status: GitSyncStatus): boolean {
  if (status.kind !== "tracked") return false;
  return status.behind > 0 || status.ahead > 0 || status.unmerged > 0;
}

function sumTracked(
  entries: Array<{ status: GitSyncStatus }>,
  pick: (status: Extract<GitSyncStatus, { kind: "tracked" }>) => number
): number {
  return entries.reduce(
    (total, { status }) =>
      status.kind === "tracked" ? total + pick(status) : total,
    0
  );
}

function describeForTooltip(work: WorkEntry, status: GitSyncStatus): string {
  if (status.kind !== "tracked") return `- ${work.title}`;
  const parts: string[] = [];
  if (status.behind > 0) parts.push(`別の環境の変更が未取得 ${status.behind}件`);
  if (status.ahead > 0) parts.push(`この環境の変更が未送信 ${status.ahead}件`);
  if (status.unmerged > 0) parts.push(`未解決の競合 ${status.unmerged}件`);
  return `- **${work.title}**（${status.branch}）: ${parts.join(" / ")}`;
}

/**
 * ツリーの作品行に出す短い説明。
 * 同期が取れているときは何も返さない（行を汚さないため）。
 */
export function describeSyncBadge(
  status: GitSyncStatus | undefined
): string | undefined {
  if (!status || status.kind !== "tracked") return undefined;
  const parts: string[] = [];
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * 状態を1文で説明する。
 * リポジトリでない・リモートが無いのは**異常ではない**ので、
 * その旨だけを伝えて操作を勧めない。
 */
export function describeStatus(status: GitSyncStatus): string {
  switch (status.kind) {
    case "git_missing":
      return "gitコマンドが見つかりません。Gitを導入すると同期の状態を見られます。";
    case "not_a_repo":
      return "この作品はGitリポジトリではありません。同期の確認は行いません。";
    case "no_remote":
      return "リモートが設定されていません。ローカルの履歴だけを取っています。";
    case "detached":
      return "特定のコミットを直接開いています（ブランチ上にありません）。";
    case "no_upstream":
      return `ブランチ「${status.branch}」に対応するリモートのブランチがありません。`;
    case "tracked": {
      const parts: string[] = [];
      if (status.behind > 0) parts.push(`未取得 ${status.behind}件`);
      if (status.ahead > 0) parts.push(`未送信 ${status.ahead}件`);
      if (status.unmerged > 0) parts.push(`未解決の競合 ${status.unmerged}件`);
      if (status.dirty > 0) parts.push(`未コミットの変更 ${status.dirty}件`);
      if (parts.length === 0) return `${status.branch}: 同期が取れています。`;
      return `${status.branch}: ${parts.join(" / ")}`;
    }
    case "failed":
      return "同期の状態を確認できませんでした。";
  }
}

/** ステータスバーを押したときの操作選択 */
export async function showGitSyncActions(
  monitor: GitSyncMonitor,
  work: WorkEntry
): Promise<void> {
  const status = await monitor.refresh(work, { fetch: true, notify: false });
  const items: Array<vscode.QuickPickItem & { action: string }> = [];

  if (status.kind === "tracked") {
    if (status.behind > 0) {
      items.push({
        label: "$(cloud-download) 取り込む",
        description: `別の環境の変更 ${status.behind}件`,
        detail:
          "未コミットの変更があるときは実行しません（書きかけの原稿を守るため）。",
        action: "pull",
      });
    }
    if (status.ahead > 0) {
      items.push({
        label: "$(cloud-upload) 送信する",
        description: `この環境の変更 ${status.ahead}件`,
        detail: "GitHubへ送ります。送信前に件数を確認します。",
        action: "push",
      });
    }
  }

  items.push({
    label: "$(sync) 状態を確認",
    description: describeStatus(status),
    detail: "リモートの状態を取得し直します（ローカルは変更しません）。",
    action: "refresh",
  });
  items.push({
    label: "$(output) ログを表示",
    description: "",
    detail: "同期に失敗した理由はここに記録しています。",
    action: "log",
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `${work.title} のGitHub同期`,
    placeHolder: describeStatus(status),
  });
  if (!picked) return;

  if (picked.action === "pull") await monitor.pull(work);
  else if (picked.action === "push") await monitor.push(work);
  else if (picked.action === "refresh") {
    await monitor.refresh(work, { fetch: true, notify: false });
    vscode.window.showInformationMessage(
      `${work.title}: ${describeStatus(
        monitor.statusFor(work.id) ?? status
      )}`
    );
  } else if (picked.action === "log") showLog();
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = normalizeForComparison(parentPath);
  const candidate = normalizeForComparison(candidatePath);
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizeForComparison(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
