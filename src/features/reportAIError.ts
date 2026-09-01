import * as vscode from "vscode";
import { AIError, recoveryForAIError, type ProviderId } from "../ai/types";
import { noteOtherLocalAiRunning } from "../ai/otherLocalAi";
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
export function reportAIError(
  context: string,
  error: unknown,
  /**
   * 失敗したプロバイダ。**モデルを読み込めなかったときだけ使う**
   * （設計書6.62.2）——もう一方の手元AIが動いていれば、
   * 「そちらを終了する」といういちばん効く一手を添える。
   *
   * 渡さなくても報告は成り立つ（これまでどおりの文面になる）。
   */
  providerId?: ProviderId
): void {
  const message = describeAIError(error);
  logFailure(context, {
    種別: error instanceof AIError ? error.kind : "unknown",
    内容: message,
  });
  const shown = vscode.window.showWarningMessage(
    `${context}に失敗しました: ${message}`
  );
  void shown;

  /*
    **メモリの取り合いは、失敗したときだけ確かめる。**

    作者のログ（2026-09-01）で、LM Studio が12Bを保持している最中に
    Ollama が18GBのモデルを載せにいって落ちた。案内は「より小さいモデルを
    選ぶか、文脈を短く」だけで、**もう一方を終了するという手を言って
    いなかった**。この拡張機能は両方を同時に使える作りなので、
    **その状況はこちらが作っている**（6.28.9）。

    確かめは1回のHTTPで済むが、**失敗したときにしか行わない**。
    動いている間ずっと相手を突く理由は無い。
  */
  if (
    providerId &&
    error instanceof AIError &&
    error.kind === "model_load_failed"
  ) {
    void noteOtherLocalAiRunning(providerId).then((note) => {
      if (note) void vscode.window.showWarningMessage(note);
    });
  }
}

/** 失敗の本文。`AIError` なら「何が起きたか＋次にできること」を並べる */
export function describeAIError(error: unknown): string {
  if (error instanceof AIError) {
    return `${error.message} ${recoveryForAIError(error)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
