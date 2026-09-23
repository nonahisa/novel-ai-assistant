import * as vscode from "vscode";
import { wideViewColumn } from "./editorColumn";
import type { WorkEntry } from "../models/types";
import { EditHistory } from "../core/editHistory";
import { ExternalAccessLog } from "../core/externalAccessStore";
import { ExternalAccessPermissionStore } from "../core/externalAccessPermissionStore";
import { describeExternalAccessPermission } from "../core/externalAccessPermission";
import { describeAiInstructionUsage } from "../core/aiInstructionUsage";
import { AiInstructionUsageStore } from "../core/aiInstructionUsageStore";
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
    wideViewColumn(),
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
  /*
    **編集履歴と外部AIの記録を、同じ画面で別の欄に出す**（設計書6.87.9）。
    混ぜないのは、外部AIが原稿を書き換えないからである——同じ流れに
    並べると、作者は「外部AIが直した」と読み違える。
  */
  const [entries, external, permission, usage] = await Promise.all([
    new EditHistory(work).load(),
    new ExternalAccessLog(work).load(),
    new ExternalAccessPermissionStore(work).load(),
    new AiInstructionUsageStore(work).load(),
  ]);
  /*
    **記録が実態より少なく見えることを、ここで断る**（設計書6.87.14 の末尾）。
    作品フォルダーを開いて使う設定なら、開いた側が直接読んだぶんは
    MCP を通らないので記録に残らない。黙っていると、作者はこの一覧を見て
    「AIはこれだけしか見ていない」と読む。
  */
  const usageNote = describeAiInstructionUsage(usage);
  void panel.webview.postMessage({
    type: "history",
    entries,
    external,
    usageNote: usageNote?.text ?? "",
    usageWarn: usageNote?.warn ?? false,
    // **いま許可されているかを、記録の上に出す**（設計書6.87.10）。
    // 記録だけを見せると、作者は「いま読まれうるのか」を判断できない
    permission: describeExternalAccessPermission(permission),
    // **1つでも許可している接続元があるか**（画面の印の出し分けに使う）
    allowed: permission.clients.length > 0,
  });
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
