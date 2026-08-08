import * as vscode from "vscode";

/**
 * 進捗表示。
 *
 * VSCodeは通知（ProgressLocation.Notification）に出した進捗へ、
 * 必ず「ソース: 小説AI執筆補助」という行を添える。
 * 拡張機能側から消す手段は用意されていないため、通知ではなく
 * ステータスバー（ProgressLocation.Window）に出す。
 *
 * ただしステータスバーの進捗には中止ボタンが付かない。
 * 長時間かかる処理では中止できないと困るので、
 * withCancellableProgress では中止ボタンを自前で並べる。
 */

/** 実行中の処理を中止するコマンド。ステータスバーのボタンから呼ぶ */
export const CANCEL_TASK_COMMAND = "novelai.cancelRunningTask";

/** 現在中止できる処理。入れ子になった場合は内側が優先される */
let activeCancellation: vscode.CancellationTokenSource | undefined;

/** activate から一度だけ呼び、戻り値を subscriptions に入れる */
export function registerProgressCancelCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(CANCEL_TASK_COMMAND, () => {
    activeCancellation?.cancel();
  });
}

type ProgressReporter = vscode.Progress<{
  message?: string;
  increment?: number;
}>;

/**
 * ステータスバーに進捗を出す。中止ボタンは付かない。
 * すぐ終わる処理（疎通確認・モデル取得など）に使う。
 */
export function withProgress<T>(
  title: string,
  task: (progress: ProgressReporter) => Thenable<T>
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title },
    (progress) => task(progress)
  );
}

/**
 * ステータスバーに進捗を出し、隣に中止ボタンを並べる。
 * AI呼び出しのように分単位でかかる処理に使う。
 */
export async function withCancellableProgress<T>(
  title: string,
  task: (
    progress: ProgressReporter,
    token: vscode.CancellationToken
  ) => Thenable<T>
): Promise<T> {
  const source = new vscode.CancellationTokenSource();
  const outer = activeCancellation;
  activeCancellation = source;

  // 文字数表示（優先度100）より右端に置き、進捗のすぐ隣に見えるようにする
  const button = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1000
  );
  button.text = "$(stop-circle) 中止";
  button.tooltip = `${title}（クリックで中止）`;
  button.command = CANCEL_TASK_COMMAND;
  button.show();

  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title },
      (progress) => task(progress, source.token)
    );
  } finally {
    button.dispose();
    source.dispose();
    activeCancellation = outer;
  }
}
