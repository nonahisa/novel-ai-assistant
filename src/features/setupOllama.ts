import * as vscode from "vscode";
import { OllamaProvider } from "../ai/ollamaProvider";
import {
  describeStartFailure,
  resolveExecutable,
  startOllama,
} from "../ai/ollamaLauncher";
import { AIRegistry, runSetupWizard } from "../ai/registry";
import { withProgress } from "../views/progress";

/**
 * Ollamaを使える状態にするまでの案内（設計書6.16）。
 *
 * Ollamaは**無料でオフラインでも使える**ので、料金を気にせず試せる唯一の
 * 選択肢である。しかし導入・起動・モデル取得の3段階があり、どれが欠けても
 * 「AIが動かない」としか見えない。**足りないものを1つずつ、順に案内する。**
 *
 * **勝手にインストールしない。** 環境を変える操作であり、管理者の権限が
 * 要ることもある（設計書5.5でGitについて決めたのと同じ方針）。
 */

/** 最初に薦めるモデル。作者の環境（8B・131072文脈）で実績がある */
const RECOMMENDED_MODEL = "gemma4:e4b";

const DOWNLOAD_PAGE = "https://ollama.com/download";

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
    const action = await vscode.window.showInformationMessage(
      "Ollamaが見つかりませんでした。無料で、インターネットに送らずに使えるAIです。" +
        "配布ページから入れたあと、もう一度この操作を実行してください。",
      "配布ページを開く",
      "実行ファイルの場所を指定",
      "閉じる"
    );
    if (action === "配布ページを開く") {
      await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_PAGE));
    } else if (action === "実行ファイルの場所を指定") {
      await vscode.commands.executeCommand("novelai.selectOllamaExecutable");
    }
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
    const action = await vscode.window.showInformationMessage(
      "Ollamaは動いていますが、モデルが1つもありません。" +
        `まずは ${RECOMMENDED_MODEL} をお勧めします（日本語が扱え、長い本文も読めます）。`,
      "ターミナルで取得する",
      "コマンドをコピー",
      "閉じる"
    );
    if (action === "ターミナルで取得する") {
      // 取得は数分かかり、進み具合が出る。拡張機能の中で隠すより、
      // ターミナルでそのまま見せたほうが状況が分かる
      const terminal = vscode.window.createTerminal("Ollama");
      terminal.show();
      terminal.sendText(`ollama pull ${RECOMMENDED_MODEL}`);
      vscode.window.showInformationMessage(
        "取得が終わったら、もう一度「Ollamaのセットアップ」を実行してください。"
      );
    } else if (action === "コマンドをコピー") {
      await vscode.env.clipboard.writeText(`ollama pull ${RECOMMENDED_MODEL}`);
      vscode.window.showInformationMessage(
        "コマンドをコピーしました。ターミナルに貼り付けて実行してください。"
      );
    }
    return;
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
