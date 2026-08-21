import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";

/**
 * ブラウザ版でのGitHubへの保存（設計書5.8.9）。
 *
 * **この拡張機能からは送れない。** gitコマンドを起動できないためである
 * （ブラウザには外部プロセスという概念が無い）。
 *
 * **代わりを自前で作らない。** GitHubのAPIを叩いてコミットを組み立てる
 * ことは理屈のうえでは可能だが、**原稿を送る道を自前で書くのは危ない**。
 * vscode.dev でリポジトリを開いている時点で、VS Code 側の仕組み
 * （ソース管理ビュー）が既にその役目を持っている。**確立して動いている
 * ものを、作り直さない。**
 *
 * ここでやるのは**行き止まりを道に変えること**だけ。「使えません」で
 * 終わらせず、どこから保存できるかを示して、その場所へ連れて行く。
 * これは操作メニューの既存の考え方（押せない理由に、次に取れる手を添える）
 * と同じである。
 */

/** ソース管理ビューを開くコマンド。VS Codeの標準ビュー */
const SCM_VIEW_COMMAND = "workbench.view.scm";

export async function showWebSyncGuide(work: WorkEntry): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    `「${work.title}」をGitHubへ保存するには、VS Codeの「ソース管理」を使います。`,
    {
      modal: true,
      detail: [
        "ブラウザ版では、この拡張機能からGitHubへ送ることはできません",
        "（gitコマンドを起動できないためです）。",
        "",
        "【保存の手順】",
        "1. 本文を保存する（Ctrl+S）",
        "2. 左端の「ソース管理」を開く",
        "3. 変更したファイルを確かめ、メッセージを書いて確定する",
        "",
        "手元のVS Codeでは、これまでどおりこの拡張機能から同期できます。",
      ].join("\n"),
    },
    "ソース管理を開く"
  );
  if (action !== "ソース管理を開く") return;

  try {
    await vscode.commands.executeCommand(SCM_VIEW_COMMAND);
  } catch {
    // **開けなくても、手順は上の案内で伝わっている。**
    // ここで別のエラーを重ねると、かえって何をすればよいか分からなくなる
    await vscode.window.showWarningMessage(
      "「ソース管理」を開けませんでした。左端のアイコン（枝分かれした線の形）から開いてください。"
    );
  }
}
