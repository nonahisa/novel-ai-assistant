import * as vscode from "vscode";
import { isEditorMode } from "../core/actorContext";
import {
  addMemoToOpenManuscript,
  insertMemoLineAbove,
  openManuscriptCaret,
} from "./manuscriptEditor";
import type { HandProposalKind } from "./handProposal";

/** 手書きの提案を置く口（作品の引き当ては呼ぶ側。extension.ts の `proposeByHandInWork`） */
export type ProposeInWork = (
  document: vscode.TextDocument,
  range: vscode.Range,
  kind: HandProposalKind
) => Promise<void>;

/**
 * 「ここにメモを足す」（`novelai.addSceneMemo`）の本体。
 *
 * **原稿エディタを先に見る。** あちらは `TextEditor` を持たないので
 * `activeTextEditor` からは辿れない（見ているのが原稿エディタでも、
 * 素のエディタで開いた別のファイルが「作業中」として返る）。
 *
 * **編集者モードでは本文に行を足さない**（設計書5.6.1.1。作者の指示 2026-11-01）。
 * その位置への意見を、提案として置く（「直しを提案する」と同じ道）。
 * 作者モードの動きは変えない。extension.ts に書くと単体で確かめられないので、ここに置く
 */
export async function addSceneMemoHere(propose: ProposeInWork): Promise<void> {
  if (isEditorMode()) {
    const caret = openManuscriptCaret();
    const editor = vscode.window.activeTextEditor;
    if (caret) {
      const index = Math.max(0, Math.min(caret.line - 1, caret.document.lineCount - 1));
      const at = new vscode.Position(index, 0);
      await propose(caret.document, new vscode.Range(at, at), "memo");
    } else if (editor) {
      await propose(editor.document, editor.selection, "memo");
    } else {
      void vscode.window.showInformationMessage(
        "メモを置く本文を開いてから実行してください。"
      );
    }
    return;
  }
  if (await addMemoToOpenManuscript()) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage(
      "メモを足す本文を開いてから実行してください。"
    );
    return;
  }
  await insertMemoLineAbove(editor.document, editor.selection.active.line + 1);
}
