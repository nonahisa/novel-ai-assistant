import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { ExternalAccessPermissionStore } from "../core/externalAccessPermissionStore";

/**
 * 外部AI（MCP）の利用を許可する／取り消す（設計書6.87.10）。
 *
 * **既定は拒否。** 拡張機能を入れただけ・MCPサーバーを登録しただけでは、
 * 外部AIは原稿を1文字も読めない。ここが**意思確認の唯一の入口**である。
 *
 * **許可の前に、何が起きるかを全部見せる。** 「許可しますか」だけを問うと、
 * 作者は何を許したのか分からないまま押すことになる。
 */

/**
 * 許可したときに何ができるようになるか。
 *
 * **できることとできないことを、両方書く。** 片方だけだと、作者は
 * 「原稿を勝手に書き換えられるのでは」と読むか、逆に「読まれるだけなら
 * 安全だ」と読む。どちらも正しくない。
 */
const WHAT_HAPPENS =
  "許可すると、この作品の本文・設定資料・プロットを、外部のAI（Claude Code など）が" +
  "MCPサーバー経由で読めるようになります。\n\n" +
  "・読むだけで、原稿も設定資料も書き換えません\n" +
  "・読まれた記録は残り、編集履歴の画面で見られます\n" +
  "・手元の Ollama で処理する分には、原稿はこの機械から出ません\n" +
  "・外部AI自身に読ませる使い方では、本文がその会社のサーバーへ渡ります\n" +
  "・許可はこの機械だけに効きます（同期しません）。いつでも取り消せます";

export async function toggleExternalAccessPermission(
  work: WorkEntry
): Promise<void> {
  const store = new ExternalAccessPermissionStore(work);
  const current = await store.load();

  if (current.allowed) {
    const answer = await vscode.window.showWarningMessage(
      `「${work.title}」は、いま外部AIの利用を許可しています。取り消しますか。`,
      { modal: true, detail: "取り消すと、外部AIはこの作品を読めなくなります。" },
      "取り消す"
    );
    if (answer !== "取り消す") return;
    await store.save(false);
    void vscode.window.showInformationMessage(
      `「${work.title}」の外部AIの利用を取り消しました。`
    );
    return;
  }

  /*
    **モーダルで問う。** 通知の隅に出して見逃されると、作者が
    「許可した覚えがない」まま原稿が読まれることになる。
  */
  const answer = await vscode.window.showWarningMessage(
    `「${work.title}」を、外部AI（MCP）に読ませることを許可しますか。`,
    { modal: true, detail: WHAT_HAPPENS },
    "許可する"
  );
  if (answer !== "許可する") return;

  await store.save(true);
  void vscode.window.showInformationMessage(
    `「${work.title}」の外部AIの利用を許可しました。読まれた記録は「編集履歴を見る」で確認できます。`
  );
}
