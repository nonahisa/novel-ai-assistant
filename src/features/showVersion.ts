import * as vscode from "vscode";
import * as path from "../core/paths";
import { AIRegistry } from "../ai/registry";
import { isVectorSearchEnabled } from "./vectorSearch";

/**
 * 拡張機能の版と、いまの環境を出す。
 *
 * ## なぜ版だけで終わらせないか
 *
 * 版が分かっても、**不具合を伝えるときに要るのはその周りの情報**である。
 * 「どのAIで」「VS Codeはいくつで」「意味検索は入か」が分からないと、
 * こちらは同じ状態を作れない。作者が画面を写して送るより、
 * **そのまま貼れる文字列**にしておくほうが手間がかからない。
 *
 * ## 版はpackage.jsonから取る
 *
 * ここに数字を書くと、版を上げたときに直し忘れて**実際と違う版を
 * 名乗る**。それは「直したはずの不具合が直っていない」と誤解させる。
 */

export interface VersionInfo {
  displayName: string;
  version: string;
  vscodeVersion: string;
  platform: string;
  /** 選ばれているAI。未設定なら undefined */
  ai?: { provider: string; model: string; paid: boolean };
  vectorSearch: boolean;
}

/**
 * 貼り付けられる形にまとめる。
 *
 * VS Code APIに触れないので、ここだけ単体テストできる。
 */
export function buildVersionReport(info: VersionInfo): string {
  const lines = [
    `${info.displayName} ${info.version}`,
    "",
    `VS Code: ${info.vscodeVersion}`,
    `OS: ${info.platform}`,
    info.ai
      ? `AI: ${info.ai.provider} / ${info.ai.model}${info.ai.paid ? "（有料）" : "（無料）"}`
      : "AI: 未設定",
    `意味検索: ${info.vectorSearch ? "入" : "切"}`,
  ];
  return lines.join("\n");
}

export async function showVersion(
  context: vscode.ExtensionContext,
  registry: AIRegistry
): Promise<void> {
  const resolved = registry.resolve();
  const packageJson = context.extension.packageJSON as {
    displayName?: string;
    version?: string;
  };

  const report = buildVersionReport({
    displayName: packageJson.displayName ?? "統合小説執筆環境",
    version: packageJson.version ?? "（不明）",
    vscodeVersion: vscode.version,
    platform: process.platform,
    ai: resolved
      ? {
          provider: resolved.provider.displayName,
          model: resolved.model,
          paid: resolved.provider.isPaid,
        }
      : undefined,
    vectorSearch: isVectorSearchEnabled(),
  });

  const copy = "コピー";
  const changelog = "変更履歴を見る";
  const picked = await vscode.window.showInformationMessage(
    report.split("\n")[0],
    { modal: true, detail: report.split("\n").slice(2).join("\n") },
    copy,
    changelog
  );

  if (picked === copy) {
    await vscode.env.clipboard.writeText(report);
    vscode.window.showInformationMessage(
      "コピーしました。不具合を伝えるときに貼り付けてください。"
    );
    return;
  }
  if (picked === changelog) {
    // 拡張機能に同梱してある。どのエディターで開くかは作者の設定に任せる
    const file = path.toUri(
      path.join(context.extensionUri.fsPath, "CHANGELOG.md")
    );
    try {
      await vscode.workspace.fs.stat(file);
      await vscode.commands.executeCommand("vscode.open", file);
    } catch {
      vscode.window.showWarningMessage(
        "変更履歴が見つかりませんでした。GitHubのCHANGELOG.mdをご覧ください。"
      );
    }
  }
}
