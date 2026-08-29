import * as vscode from "vscode";
import { AIError, recoveryForAIError } from "../ai/types";
import { logFailure } from "../core/logger";

/**
 * AIの失敗を、作者へ伝えてログにも残す（設計書6.44）。
 *
 * **同じものが4つに写っていた**（冒頭診断・紹介文とキャッチコピー・
 * 名前の候補・更新告知文）。1文字も違わない写しで、直すときに片方だけ
 * 直る形だった。5つ目を作らせないためにここへ集める。
 *
 * ここが守っていること（CLAUDE.md 規則5）：
 *
 * - **失敗の種別ごとに、次に取れる操作を1つ添える**（`recoveryForAIError`）
 * - **本文を捨てない。** 通知は短くても、ログには種別と内容を残す——
 *   残さないと作者も開発側も原因へたどり着けない
 * - APIキーらしき文字列は `logFailure` が伏せる
 *
 * @param context 「作品紹介文の生成」のような処理の名前。通知とログの
 *   見出しになるので、**作者が押した操作の名前**を渡すこと
 */
export function reportAIError(context: string, error: unknown): void {
  const message = describeAIError(error);
  logFailure(context, {
    種別: error instanceof AIError ? error.kind : "unknown",
    内容: message,
  });
  void vscode.window.showWarningMessage(`${context}に失敗しました: ${message}`);
}

/** 失敗の本文。`AIError` なら「何が起きたか＋次にできること」を並べる */
export function describeAIError(error: unknown): string {
  if (error instanceof AIError) {
    return `${error.message} ${recoveryForAIError(error)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
