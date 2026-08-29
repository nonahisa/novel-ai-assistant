import * as vscode from "vscode";
import { OllamaProvider } from "../ai/ollamaProvider";
import {
  describeStartFailure,
  resolveExecutable,
  startOllama,
} from "../ai/ollamaLauncher";
import { AIRegistry, runSetupWizard } from "../ai/registry";
import { pullOllamaModel, shortenProgress } from "../core/packageInstall";
import { RECOMMENDED_CHAT_MODEL } from "../core/requirements";
import { runFullSetup } from "./setupWizard";
import { withCancellableProgress, withProgress } from "../views/progress";

/**
 * Ollamaを使える状態にするまでの案内（設計書6.16）。
 *
 * Ollamaは**無料でオフラインでも使える**ので、料金を気にせず試せる唯一の
 * 選択肢である。しかし導入・起動・モデル取得の3段階があり、どれが欠けても
 * 「AIが動かない」としか見えない。**足りないものを1つずつ、順に案内する。**
 *
 * **2026-08-15に方針を変えた。** 以前は「勝手にインストールしない。配布
 * ページを開くだけ」としていたが、作者から自動導入の指定があった。
 * 本体が見つからないときは統合セットアップ（`setupWizard.ts`）へ渡す。
 * そちらが何を・どれだけ・なぜ入れるのかを見せてから実行する。
 */

/**
 * 最初に薦めるモデル。**名前は `core/requirements.ts` が持つ**（規則6）。
 *
 * かつてここに同じ値を書いていた（`RECOMMENDED_MODEL = "gemma4:e4b"`。
 * コメントまで一字一句同じ写しだった）。**薦めるモデルを変えるときに
 * 片方だけ直る形**で、統合セットアップは新しいモデルを勧めるのに、
 * こちらは古いモデルを取りに行く——という食い違いになる（0.28.6）。
 */
const RECOMMENDED_MODEL = RECOMMENDED_CHAT_MODEL;

export async function setupOllama(registry: AIRegistry): Promise<void> {
  const endpoint = vscode.workspace
    .getConfiguration("novelai")
    .get<string>("ollama.endpoint", "http://localhost:11434");

  // ① 入っているか
  const executable = await resolveExecutable(
    vscode.workspace
      .getConfiguration("novelai")
      .get<string>("ollama.executablePath", "") || undefined
  );
  // 接続先は設定から読む（プロバイダが自分で見に行く）
  const provider = new OllamaProvider();
  let connection = await withProgress("Ollamaを探しています…", () =>
    provider.testConnection()
  );

  if (!executable && !connection.ok) {
    // 本体から入れる話になる。ここで配布ページを開くより、
    // 何が要るのかを一覧で見せてから入れたほうが迷わない
    await runFullSetup(registry);
    return;
  }

  // ② 起動しているか
  if (!connection.ok) {
    const start = await vscode.window.showInformationMessage(
      "Ollamaは入っていますが、起動していないようです。起動しますか？",
      "起動する",
      "閉じる"
    );
    if (start !== "起動する") return;

    const outcome = await withProgress("Ollamaを起動しています…", () =>
      startOllama({ endpoint })
    );
    if (!outcome.ok) {
      vscode.window.showErrorMessage(describeStartFailure(outcome));
      return;
    }
    connection = await provider.testConnection();
    if (!connection.ok) {
      vscode.window.showErrorMessage(connection.message);
      return;
    }
  }

  // ③ モデルがあるか
  if ((connection.modelCount ?? 0) === 0) {
    const get = "取得する";
    const action = await vscode.window.showInformationMessage(
      "Ollamaは動いていますが、モデルが1つもありません。" +
        `まずは ${RECOMMENDED_MODEL} をお勧めします（日本語が扱え、長い本文も読めます。約9.6GB）。`,
      get,
      "コマンドをコピー",
      "閉じる"
    );
    if (action === get) {
      // **終わりを待つ。** ターミナルへ流すと終了を拡張機能が知れず、
      // 「終わったらもう一度実行してください」と頼むことになる
      const outcome = await withCancellableProgress(
        `${RECOMMENDED_MODEL} を取得しています`,
        async (progress, token) =>
          pullOllamaModel(RECOMMENDED_MODEL, {
            onLine: (line) => {
              if (token.isCancellationRequested) return;
              progress.report({ message: shortenProgress(line) });
            },
          })
      );
      if (outcome.kind === "failed") {
        vscode.window.showErrorMessage(`取得に失敗しました。${outcome.detail}`);
        return;
      }
      connection = await provider.testConnection();
    } else if (action === "コマンドをコピー") {
      await vscode.env.clipboard.writeText(`ollama pull ${RECOMMENDED_MODEL}`);
      vscode.window.showInformationMessage(
        "コマンドをコピーしました。ターミナルに貼り付けて実行してください。"
      );
      return;
    } else {
      return;
    }
  }

  // ④ 使うAIとして選ぶ
  const action = await vscode.window.showInformationMessage(
    `${connection.message} このままOllamaを使う設定にしますか？`,
    "設定する",
    "あとで"
  );
  if (action === "設定する") {
    await runSetupWizard(registry);
  }
}
