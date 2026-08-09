import * as vscode from "vscode";
import * as path from "path";

/**
 * 診断用のログ。
 *
 * AI呼び出しの失敗は、通知には「何が起きたか」と「次にどうするか」だけを出し、
 * プロバイダーが返した本文は載せていない。通知は目に入りやすく、
 * 応答本文に何が混ざるかを制御できないため。
 *
 * ただし本文が**どこにも残らない**と、作者が原因にたどり着けず、
 * こちらも直しようがない。そこで作者が自分で開くログにだけ残す。
 *
 * **出力パネルに加えてファイルにも書く。** パネルの内容はVS Codeを閉じると消え、
 * 作者が画面を写して伝えるしかなくなる。とくに「止まった」ときは
 * 失敗の記録が残らないため、どこまで進んだかを後から追えることが要る。
 * 置き場所は `.aiwriter/logs/`（Git同期の対象外）。
 */

let channel: vscode.OutputChannel | undefined;

/** ログを書き込む先。作品を開いたときに設定する */
let logFilePath: string | undefined;
/** 書き込みは順番に行う。並行して呼ばれると行が混ざる */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * ログファイルの置き場所を決める。
 * 作品ごとに分けず1つにするのは、作品をまたいだ操作の順序も追いたいため。
 */
export function useLogFile(workFolderPath: string): void {
  logFilePath = path.join(workFolderPath, ".aiwriter", "logs", "actions.log");
}

/** 1ファイルが際限なく育たないようにする上限 */
const MAX_LOG_BYTES = 1_000_000;

function appendToFile(text: string): void {
  const target = logFilePath;
  if (!target) return;

  // 失敗しても本来の処理は止めない。ログが書けないことより、
  // 抽出が中断するほうが作者にとって困る
  writeQueue = writeQueue
    .then(async () => {
      const uri = vscode.Uri.file(target);
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(target))
      );
      let existing: Uint8Array;
      try {
        existing = await vscode.workspace.fs.readFile(uri);
      } catch {
        existing = new Uint8Array();
      }
      const addition = new TextEncoder().encode(`${text}\n`);
      // 上限を超えたら古いほうから捨てる。直近が読めることを優先する
      const merged =
        existing.byteLength + addition.byteLength > MAX_LOG_BYTES
          ? addition
          : concat(existing, addition);
      await vscode.workspace.fs.writeFile(uri, merged);
    })
    .catch(() => undefined);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

export function outputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("小説AI執筆補助");
  }
  return channel;
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}

export function showLog(): void {
  outputChannel().show(true);
}

export function logLine(message: string): void {
  const time = new Date().toISOString().slice(11, 19);
  outputChannel().appendLine(`[${time}] ${redactSecrets(message)}`);
}

/** 失敗の詳細を、作者が読める形で残す */
export function logFailure(
  context: string,
  detail: Record<string, unknown>
): void {
  const lines = [`--- ${context} ---`];
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`  ${key}: ${String(value)}`);
  }
  logLine(lines.join("\n"));
}

/**
 * APIキーらしき文字列を伏せる。
 *
 * キー自体はヘッダーで送っており応答本文には現れないはずだが、
 * 作者がログを貼って助けを求めることを考えると、
 * 万一混ざったときの被害が大きい。念のため伏せる。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, "AIza***")
    .replace(/AQ\.[A-Za-z0-9_-]{8,}/g, "AQ.***");
}
