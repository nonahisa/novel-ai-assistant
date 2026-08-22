import * as vscode from "vscode";
import { toUri } from "../core/paths";
import { canRunProcesses } from "../core/runtime";

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

/**
 * その場所を、作者に見せる（設計書5.8.10）。
 *
 * 書き出しやまとめが済んだあとの「フォルダーを開く」に使う。
 *
 * **ブラウザ版では、OSのフォルダーを開けない。** `revealFileInOS` は
 * 手元のVS Codeにしか無いコマンドで、呼ぶと失敗する。かといって
 * ボタンごと消すと、**書き出したものがどこへ行ったのか分からなくなる**
 * ——機能そのものはブラウザでも動いているので、そこだけ行き止まりにしない。
 *
 * 代わりに、VS Code の中のエクスプローラーで在り処を見せる。
 * 開けなかったときは黙って諦める——**もとの用は済んでいる**（書き出しは
 * 成功していて、その旨は先に伝えてある）ので、ここで失敗を重ねて
 * 作者を驚かせない。
 */
export async function revealFolder(location: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      revealCommandFor(canRunProcesses()),
      toUri(location)
    );
  } catch {
    // 在り処は、呼び出し元がすでに文言で伝えている
  }
}

/**
 * 場所を見せるのに使うコマンド名。
 *
 * **`canRunProcesses()` は実行環境そのものを見るので、単体テストからは
 * 片側（常にNode）しか確かめられない。** どちらを選ぶかだけを切り出して、
 * 両方の分岐をテストできるようにする（`providerRuntimeFilter.ts` と同じ手）。
 */
export function revealCommandFor(canRun: boolean): string {
  // `revealFileInOS` は手元のVS Codeにしか無い。
  // ブラウザでは VS Code の中のエクスプローラーで見せる
  return canRun ? "revealFileInOS" : "revealInExplorer";
}
