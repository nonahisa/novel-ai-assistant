import * as vscode from "vscode";
import { isEditorMode } from "./actorContext";

/**
 * 編集者モードかどうかの印（package.json の `when` で使う）。
 *
 * **VS Code の設定の読み（`config.novelai.mode`）に頼らない。** 2026-11-07 の作者の実機
 * （VS Code 1.145.2・0.130.3）で、拡張機能は編集者モードと読んでいたのに、欄の `when` の
 * `config.novelai.mode` は editor と読まれず、簡単ステップメニューが残り、編集者メニューが
 * 出なかった。拡張機能が読んだモードを、そのまま印にして立てる
 */
export const EDITOR_MODE_CONTEXT = "novelai.editorMode";

/** いまのモードを印へ写す。待たずに呼んでよい（失敗しても画面の出し分けが古いままになるだけ） */
export function syncEditorModeContext(): Thenable<unknown> {
  return vscode.commands
    .executeCommand("setContext", EDITOR_MODE_CONTEXT, isEditorMode())
    .then(undefined, () => undefined);
}
