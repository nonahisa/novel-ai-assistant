import * as vscode from "vscode";
import { toUri } from "../core/paths";

/**
 * 作者の既定のエディターでファイルを開く（設計書6.17.6）。
 *
 * **`openTextDocument` + `showTextDocument` は、常に素のテキストエディターで
 * 開く。** 作者が `workbench.editorAssociations` で `*.md` に Markdown の
 * エディターを割り当てていても、無視される。
 *
 * 実際に起きた（2026-08-21、作者が実機で発見）。`plot.md` だけが
 * 「テキスト エディター」で開き、記法がそのまま並んでいた。作品一覧から
 * 開いた `.md` は Markdown のエディターで出るのに、こちらだけ違っていた。
 *
 * `vscode.open` は**既定の割り当てを通る**ので、作者の設定どおりに開く。
 *
 * ## エディターの実体が要るときは、これを使わない
 *
 * 該当行へ飛ぶ・選択範囲を作るといった操作には `TextEditor` が要る。
 * `vscode.open` は何も返さないので、そこは `showTextDocument` のままにする
 * （提案パネルの「該当箇所へ移動」、ルビを振る、相談パネルの引用）。
 */
export async function openInDefaultEditor(
  filePath: string,
  options?: vscode.TextDocumentShowOptions
): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.open",
    toUri(filePath),
    options
  );
}
