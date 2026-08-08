import * as vscode from "vscode";

/**
 * 診断用のログ。
 *
 * AI呼び出しの失敗は、通知には「何が起きたか」と「次にどうするか」だけを出し、
 * プロバイダーが返した本文は載せていない。通知は目に入りやすく、
 * 応答本文に何が混ざるかを制御できないため。
 *
 * ただし本文が**どこにも残らない**と、作者が原因にたどり着けず、
 * こちらも直しようがない。そこで作者が自分で開くログにだけ残す。
 */

let channel: vscode.OutputChannel | undefined;

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
