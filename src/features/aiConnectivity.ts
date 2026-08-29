import * as vscode from "vscode";
import type {
  AIProvider,
  ConnectionTestResult,
} from "../ai/types";
import { lmstudioEndpoint } from "../ai/lmstudioProvider";
import { canRunProcesses } from "../core/runtime";
import { withProgress } from "../views/progress";

/**
 * AIへの疎通確認と、手元で動くAI（Ollama・LM Studio）の起動導線。
 *
 * 設定資料の抽出・誤字脱字検知など、AIを繰り返し呼ぶ機能で共通に使う。
 * 抽出機能側にあったものをそのまま切り出しただけで、中身は変えていない。
 *
 * **`ai/ollamaLauncher.ts` と `ai/lmstudioLauncher.ts` は動的importで
 * 持ってくる。** どちらも `node:child_process` を静的importしている
 * Node専用のファイルで、このファイル自体はどのAIプロバイダでも通る道
 * （`extractCharacters.ts` 経由でブラウザ版にも必要）なので、静的import
 * すると巻き込んでしまう（設計書5.8.5）。呼ぶのはOllama・LM Studioを
 * 選んでいるときだけなので、ブラウザでは実際には呼ばれない。
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

    // **LM Studioへのモデルの読み込みは、ここでは行わない。**
    // AI機能の入口（`ai/registry.ts` の `ensureConfigured`）が
    // 必ず先に通っており、そこで済んでいる。同じことを2か所でやると、
    // 片方だけ直したときに食い違う
    if (result.ok) return true;

    // 手元で動くAIなら、この場から起動できる。別マシンを指しているときと
    // ブラウザ版では、押しても必ず失敗するので選択肢自体を出さない
    const startLabel = await localStartLabel(provider.id);

    const action = await vscode.window.showWarningMessage(
      `AIに接続できないため、${actionLabel}を開始できません。\n${result.message}`,
      ...(startLabel ? [startLabel] : []),
      "再試行",
      "設定を開く",
      "中止"
    );

    if (action === "Ollamaを起動") {
      const started = await startOllamaWithProgress();
      if (!started) continue; // 失敗理由は起動側で通知済み。再度この警告へ戻る
      continue; // 起動できたので疎通を確認し直す
    }
    if (action === "LM Studioを起動") {
      const started = await startLmStudioWithProgress();
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

/**
 * この場から起動できるなら、そのボタンの文言。できなければ undefined。
 *
 * **サービス名を決め打ちしない。** 使っているのがLM Studioなのに
 * 「Ollamaを起動」と出ては、押しても何も起きない
 * （Geminiを使っているのに「Claudeの…」と出た不具合と同じ形）。
 */
async function localStartLabel(
  providerId: string
): Promise<string | undefined> {
  if (providerId === "ollama") {
    return (await isLocalOllamaEndpoint()) ? "Ollamaを起動" : undefined;
  }
  if (providerId === "lmstudio") {
    return (await isLocalLmStudioEndpoint()) ? "LM Studioを起動" : undefined;
  }
  return undefined;
}

export function ollamaEndpoint(): string {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<string>("ollama.endpoint", "http://localhost:11434");
}

export async function isLocalOllamaEndpoint(): Promise<boolean> {
  const { isLocalEndpoint } = await import("../ai/ollamaLauncher.js");
  return isLocalEndpoint(ollamaEndpoint());
}

export async function isLocalLmStudioEndpoint(): Promise<boolean> {
  // ブラウザ版では外部プロセスを起こせない。Node専用のファイルを
  // 読み込む前に確かめる（読み込んだ時点で落ちるため）
  if (!canRunProcesses()) return false;
  const { isLocalEndpoint } = await import("../ai/lmstudioLauncher.js");
  return isLocalEndpoint(lmstudioEndpoint());
}

/** LM Studioのサーバーを起動し、応答するまで進捗を出しながら待つ */
export async function startLmStudioWithProgress(): Promise<boolean> {
  const { describeStartFailure, startLmStudioServer } = await import(
    "../ai/lmstudioLauncher.js"
  );
  const outcome = await withProgress(
    "LM Studioのサーバーを起動しています…",
    () =>
      startLmStudioServer({
        endpoint: lmstudioEndpoint(),
        cliPath: vscode.workspace
          .getConfiguration("novelai")
          .get<string>("lmstudio.cliPath", ""),
      })
  );

  if (outcome.ok) {
    vscode.window.showInformationMessage("LM Studioのサーバーを起動しました。");
    return true;
  }

  // コマンドが見つからないときは、場所を指定できる場所まで連れて行く。
  // 「設定で指定してください」と言うだけでは、どこにあるのか分からない
  if (outcome.reason === "not_installed") {
    const action = await vscode.window.showWarningMessage(
      describeStartFailure(outcome),
      "設定を開く",
      "閉じる"
    );
    if (action === "設定を開く") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "novelai.lmstudio.cliPath"
      );
    }
    return false;
  }

  await vscode.window.showWarningMessage(describeStartFailure(outcome));
  return false;
}

/** Ollamaを起動し、応答するまで進捗を出しながら待つ */
export async function startOllamaWithProgress(): Promise<boolean> {
  const { describeStartFailure, startOllama } = await import(
    "../ai/ollamaLauncher.js"
  );
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

/**
 * 有料のAIを使う前に、料金がかかることを知らせて確認を取る。
 *
 * **無料（Ollama）のときは何も出さない。** 毎回確認を挟むと、
 * ローカルで気軽に試す使い方が成り立たなくなる。
 *
 * 抽出（`extractCharacters`）や誤字脱字検知（`checkTypos`）は、
 * 処理するチャンク数からトークン量を見積もった独自の案内を出している。
 * こちらは**見積もりの材料が無い操作**（相談・プロット逆算など、
 * 1回で終わるもの）のための共通の確認である。
 *
 * @returns 実行してよければ true
 */
export async function confirmPaidUsage(
  provider: AIProvider,
  options: {
    /** 何をするか。「作品紹介文の生成」など */
    actionLabel: string;
    model: string;
    /** AIを何回呼ぶか。分かるときだけ添える */
    calls?: number;
    /** 追加の説明。処理の大きさが分かるもの */
    detail?: string;
  }
): Promise<boolean> {
  if (!provider.isPaid) return true;

  const lines = [
    `${provider.displayName}（${options.model}）を使います。`,
    "実行するとトークンを消費し、利用量が加算されます。",
  ];
  if (options.calls !== undefined) {
    lines.push(
      options.calls === 1
        ? "AIの呼び出しは1回です。"
        : `AIの呼び出しは ${options.calls} 回です。`
    );
  }
  if (options.detail) lines.push(options.detail);
  lines.push(
    "実際の金額はモデル・実使用量・各社の現行料金によって変わります。"
  );

  const answer = await vscode.window.showInformationMessage(
    `${options.actionLabel}を実行しますか`,
    { modal: true, detail: lines.join("\n") },
    "実行"
  );
  return answer === "実行";
}
