import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { EditHistory } from "../core/editHistory";
import { buildEditHistoryHtml } from "../views/editHistoryPanelHtml";

/**
 * 編集履歴の画面（設計書5.6）。
 *
 * **見るだけの画面である。** ここから履歴を直せると、履歴の意味が無くなる。
 *
 * 作品ごとに1枚。すでに開いていれば、そこへ読み直したものを流す。
 */
const openPanels = new Map<string, vscode.WebviewPanel>();

export async function showEditHistory(
  context: vscode.ExtensionContext,
  work: WorkEntry
): Promise<void> {
  const existing = openPanels.get(work.id);
  if (existing) {
    existing.reveal();
    await postHistory(existing, work);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "novelai.editHistory",
    `編集履歴: ${work.title}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  openPanels.set(work.id, panel);
  context.subscriptions.push(panel);
  panel.onDidDispose(() => openPanels.delete(work.id));

  panel.webview.html = buildEditHistoryHtml(
    createNonce(),
    panel.webview.cspSource
  );

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    // HTMLを流し込んだ直後は受け手がまだ居ない。
    // WebView側から準備完了を知らせてもらってから送る
    if ((message as { type?: string }).type === "ready") {
      await postHistory(panel, work);
    }
  });
}

async function postHistory(
  panel: vscode.WebviewPanel,
  work: WorkEntry
): Promise<void> {
  const entries = await new EditHistory(work).load();
  void panel.webview.postMessage({ type: "history", entries });
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
