import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { findWorkForFile } from "../core/workRegistry";
import { readMemoMarkers } from "../core/memoMarkerStore";
import { UnclosedMemoNoticeMemory } from "../core/memoMarkers";
import { unclosedMemoCommentLine } from "../core/sceneMemo";

/**
 * 原稿を保存したとき、閉じていないメモの囲み（`<!--` だけで `-->` が無い）を知らせる
 * （設計書6.40.8。作者の決定 2026-11-14 夜）。
 *
 * 閉じていない囲みは**メモにしない**（本文のまま数え、投稿にも出す）。黙って本文を消さない
 * ことを優先した決まりなので、作者が気づけるよう保存の時に1回だけ言う。校正・メモパネルにも
 * 同じ場所の行が出る（`core/sceneMemo.ts` の `unclosedCommentMemo`）。
 *
 * **答えを待たない**（ボタンの無い知らせ）。保存の流れを止めない。
 */
const memory = new UnclosedMemoNoticeMemory();

export async function noticeUnclosedMemoComment(
  works: readonly WorkEntry[],
  document: vscode.TextDocument
): Promise<void> {
  const filePath = path.fromUri(document.uri);
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".txt" && ext !== ".md") return;
  const work = findWorkForFile(works, filePath);
  if (!work) return;
  let markers;
  try {
    markers = await readMemoMarkers(work);
  } catch {
    // 設定が読めないときの知らせは、印を使う側（字数・投稿・書き出し）が出す
    return;
  }
  if (!markers.comment) return;
  const line = unclosedMemoCommentLine(document.getText(), markers);
  if (!memory.shouldNotify(path.pathKeyForComparison(filePath), line)) return;
  void vscode.window.showWarningMessage(
    `「${path.basename(filePath)}」の${line}行目の <!-- が閉じていません。` +
      "--> を書くまで、この行からあとはメモにせず、本文として数え、投稿にも出します" +
      "（校正・メモパネルにも出ています）。"
  );
}
