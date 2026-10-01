import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { atomicWriteFile } from "./atomicWrite";
import { parseNotifiedNarrators } from "./rejectedNarratorNotice";

/**
 * 「語り手を捨てた断り」を画面に出した呼び名の覚書（作者の裁定、2026-10-01）。
 *
 * `.aiwriter/narrator-notified.json`。作品ごとに持つ。`extractedIndexStore.ts` と
 * 同じく拡張機能だけが書くので、そのまま置き換えてよい（`atomicWriteFile` を
 * 引数無しで呼ぶ。③の `replaceGuarded` ではない）。同期の対象でよい
 * ——別の環境で一度見た断りを、こちらで読み直す必要はない。
 */

const FILE_NAME = "narrator-notified.json";

function filePath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, FILE_NAME);
}

/** 覚えている呼び名。無い・壊れているときは空（断りがもう一度出るだけ） */
export async function readNotifiedNarrators(
  work: WorkEntry
): Promise<Set<string>> {
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(filePath(work)));
    return parseNotifiedNarrators(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return new Set();
  }
}

/**
 * 画面に出した呼び名を足して覚える。**失敗しても抽出は止めない**
 * ——覚えそこねても、次回に断りがもう一度出るだけである。
 */
export async function rememberNotifiedNarrators(
  work: WorkEntry,
  known: ReadonlySet<string>,
  added: readonly string[]
): Promise<void> {
  if (added.length === 0) return;
  const names = [...new Set([...known, ...added])];
  try {
    await vscode.workspace.fs.createDirectory(
      path.toUri(workPaths(work).aiwriter)
    );
    await atomicWriteFile(
      filePath(work),
      new TextEncoder().encode(`${JSON.stringify({ names }, null, 2)}\n`)
    );
  } catch {
    // 覚えそこねは黙ってよい（上のとおり、次回また出るだけ）
  }
}
