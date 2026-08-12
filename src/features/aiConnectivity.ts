import * as vscode from "vscode";
import type {
  AIProvider,
  ConnectionTestResult,
} from "../ai/types";
import {
  describeStartFailure,
  isLocalEndpoint,
  startOllama,
} from "../ai/ollamaLauncher";
import { withProgress } from "../views/progress";

/**
 * AIへの疎通確認と、ローカルOllamaの起動導線。
 *
 * 設定資料の抽出・誤字脱字検知など、AIを繰り返し呼ぶ機能で共通に使う。
 * 抽出機能側にあったものをそのまま切り出しただけで、中身は変えていない。
 */

/**
 * AIを呼び始める前に疎通を確認する。
 *
 * Ollamaが起動していない・ネットワークが切れている場合、
 * 確認せずに走らせると全チャンクが同じ理由で失敗するだけなので、
 * 開始前に止めて作者に理由と対処を伝える。
 */
export async function confirmProviderReachable(
  provider: Pick<AIProvider, "id" | "testConnection">,
  /** 確認できないときに出す文言に埋め込む、実行しようとしている処理名 */
  actionLabel: string
): Promise<boolean> {
  // testConnection を持たないプロバイダは確認をスキップする（実行自体は妨げない）
  if (typeof provider.testConnection !== "function") return true;

  for (;;) {
    let result: ConnectionTestResult;
    try {
      result = await withProgress("AIに接続できるか確認しています…", () =>
        provider.testConnection()
      );
    } catch (error) {
      // testConnection 自体が落ちた場合も「接続できない」として扱う
      result = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.ok) return true;

    // ローカルのOllamaなら、この場から起動できる
    const canStart = provider.id === "ollama" && isLocalOllamaEndpoint();

    const action = await vscode.window.showWarningMessage(
      `AIに接続できないため、${actionLabel}を開始できません。\n${result.message}`,
      ...(canStart ? ["Ollamaを起動"] : []),
      "再試行",
      "設定を開く",
      "中止"
    );

    if (action === "Ollamaを起動") {
      const started = await startOllamaWithProgress();
      if (!started) continue; // 失敗理由は起動側で通知済み。再度この警告へ戻る
      continue; // 起動できたので疎通を確認し直す
    }
    if (action === "再試行") continue;
    if (action === "設定を開く") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `novelai.${provider.id}`
      );
    }
    return false;
  }
}

export function ollamaEndpoint(): string {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<string>("ollama.endpoint", "http://localhost:11434");
}

export function isLocalOllamaEndpoint(): boolean {
  return isLocalEndpoint(ollamaEndpoint());
}

/** Ollamaを起動し、応答するまで進捗を出しながら待つ */
export async function startOllamaWithProgress(): Promise<boolean> {
  const outcome = await withProgress("Ollamaを起動しています…", () =>
    startOllama({
      endpoint: ollamaEndpoint(),
      executablePath: vscode.workspace
        .getConfiguration("novelai")
        .get<string>("ollama.executablePath", ""),
    })
  );

  if (outcome.ok) {
    vscode.window.showInformationMessage("Ollamaを起動しました。");
    return true;
  }

  // 実行ファイルが見つからない場合は、その場で選んでもらえるようにする
  if (outcome.reason === "not_installed") {
    const action = await vscode.window.showWarningMessage(
      describeStartFailure(outcome),
      "実行ファイルを選択",
      "閉じる"
    );
    if (action === "実行ファイルを選択") {
      await vscode.commands.executeCommand("novelai.selectOllamaExecutable");
    }
    return false;
  }

  await vscode.window.showWarningMessage(describeStartFailure(outcome));
  return false;
}
