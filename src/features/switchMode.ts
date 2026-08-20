import * as vscode from "vscode";
import { currentMode } from "../core/actorContext";
import { editorAllowedCommands, type WorkMode } from "../core/editorMode";

/**
 * 作者モードと編集者モードを切り替える（設計書5.6.1）。
 *
 * **設定を直接いじらせない。** これまでは `novelai.mode` を設定画面で
 * `editor` にするしか道が無かった。**編集部の方が、項目名を知らないまま
 * 設定画面から探し当てるのは無理である**（作者の指摘、2026-08-19）。
 *
 * ## 切り替えると何が変わるかを、先に見せる
 *
 * 編集者モードにすると**操作メニューの多くが押せなくなる。** 理由を知らずに
 * 切り替えると「壊れた」と思う。**何ができて何ができなくなるかを、
 * 押す前に出す。**
 *
 * ## 戻る道を必ず残す
 *
 * この操作は**編集者モードでも使える**（`EDITOR_ALLOWED`）。
 * 入ったら出られない、が起きてはならない。
 */
export async function switchMode(): Promise<void> {
  const now = currentMode();
  const next: WorkMode = now === "author" ? "editor" : "author";

  const answer = await vscode.window.showWarningMessage(
    now === "author"
      ? "この環境を「編集者」として使いますか。"
      : "この環境を「作者」に戻しますか。",
    { modal: true, detail: describe(next) },
    now === "author" ? "編集者にする" : "作者に戻す"
  );
  if (!answer) return;

  // **環境ごとの設定である。** 作品ごとではない
  await vscode.workspace
    .getConfiguration("novelai")
    .update("mode", next, vscode.ConfigurationTarget.Global);

  void vscode.window.showInformationMessage(
    next === "editor"
      ? "編集者モードにしました。本文の校正・校閲だけを行えます。" +
          "戻すときは、同じ操作をもう一度選んでください。"
      : "作者モードに戻しました。すべての機能が使えます。"
  );
}

/** 操作メニューに出す見出し。**いまどちらなのかが分かるようにする** */
export function modeLabel(): string {
  return currentMode() === "author"
    ? "編集者モードにする（いまは作者）"
    : "作者モードに戻す（いまは編集者）";
}

/**
 * 切り替えると何が変わるか。
 *
 * **できなくなることを具体的に書く。** 「機能が制限されます」では、
 * 何が消えるのか分からないまま押すことになる。
 */
function describe(next: WorkMode): string {
  if (next === "author") {
    return (
      "すべての機能が使えるようになります。\n\n" +
      "本文への修正も、そのまま反映されるようになります" +
      "（編集者モードでは提案として置かれます）。"
    );
  }
  return [
    "本文の校正・校閲だけを行える状態になります。",
    "",
    "【できること】",
    "誤字脱字・表記ゆれ・推敲の検知、直さない語の管理、",
    "原稿の同期と競合の解決、文字数の確認、設定資料を読むこと。",
    "",
    "【できなくなること】",
    "設定資料の抽出と更新、プロット、あらすじや紹介文の生成、",
    "執筆統計、新規作品の作成。",
    "消えるのではなく、押せなくなって理由が出ます。",
    "",
    "本文は書き換わりません。「適用」を押しても、作者への提案として",
    "置かれます。採るかどうかは作者が決めます。",
    "",
    `（${editorAllowedCommands().length}個の操作が使えます）`,
  ].join("\n");
}
