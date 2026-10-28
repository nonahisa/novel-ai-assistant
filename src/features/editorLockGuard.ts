import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { describeLock } from "../models/fileLock";
import { editorLockOf } from "../core/fileLockStore";
import { isEditorMode } from "../core/actorContext";
import { setBodyWriteGuard } from "../core/textFile";
import { logFailure, logStep, useLogFile } from "../core/logger";

/**
 * 編集部が校閲中の話を、作者が書けないようにする（作者の裁定、2026-10-28）。
 *
 * 基本は「書けなくする」。止められる道と止められない道がある。
 *
 * **止める（断って理由を出す）**
 * - 本文への書き込みの共通の入口（`writeTextFilePreservingFormat`）：AI の書き戻し、
 *   提案の適用、改行の統一など。ここへ関所（`setBodyWriteGuard`）を差し込む
 * - 原稿エディター（WebView）の打鍵：`manuscriptEditor.ts` が `editorLockOf` で見て、
 *   本体の文書へ入れずに画面へ戻す
 *
 * **止められない（警告だけ）**
 * - VS Code の素のテキストエディター：開いたとき・保存されたときに警告を出す。
 *   保存された版は、編集部の版を守るため送り直しの対象から外れる
 * - 拡張機能の外（別のエディタ、MCP の別プロセス）での書き換え
 */

/** 作品の中のファイルなら、その作品 */
function workOfFile(
  registry: { list(): readonly WorkEntry[] },
  filePath: string
): WorkEntry | undefined {
  return [...registry.list()]
    .sort((a, b) => b.folderPath.length - a.folderPath.length)
    .find((work) => path.isPathInside(work.folderPath, filePath));
}

/** どの道から来た書き込みかをログで分かるように、呼び出しの上の数段を短く取る */
function callerHint(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  return frames
    .filter((line) => !/textFile|editorLockGuard|node:internal/.test(line))
    .slice(0, 3)
    .map((line) => line.trim().replace(/^at /, "").replace(/\(.*[\\/]/, "("))
    .join(" ← ");
}

/** 断りの文（理由と、解く手段） */
export function describeRefusal(fileName: string, lockText: string): string {
  return (
    `「${fileName}」は編集部が校閲中のため、書き込めません（${lockText}）。` +
    "編集部と連絡がつかないときは、「編集部連携を解除」で解けます。"
  );
}

/** 同じ話への警告は続けて出さない */
const warnedAt = new Map<string, number>();
const WARN_INTERVAL_MS = 5 * 60_000;

async function warnAboutLockedFile(
  registry: { list(): readonly WorkEntry[] },
  uri: vscode.Uri,
  kind: "opened" | "saved"
): Promise<void> {
  if (uri.scheme !== "file" || isEditorMode()) return;
  const filePath = path.fromUri(uri);
  const work = workOfFile(registry, filePath);
  if (!work) return;
  const lock = await editorLockOf(work, filePath);
  if (!lock) return;

  const key = `${kind}:${uri.toString()}`;
  const now = Date.now();
  const last = warnedAt.get(key);
  if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
  warnedAt.set(key, now);

  const name = path.basename(filePath);
  useLogFile(work.folderPath);
  logStep(`編集部が校閲中の話を素のエディターで${kind === "opened" ? "開いた" : "保存した"}: ${name}`);
  const message =
    kind === "opened"
      ? `「${name}」は編集部が校閲中です（${describeLock(lock)}）。` +
        "ここで書いても、校閲が終わるまで編集部へは送られません。"
      : `「${name}」を保存しました。この話は編集部が校閲中のため、編集部へは送り直されません` +
        "（校閲が終わったあとの送り直しで、作者の版が反映されます）。";
  const action = await vscode.window.showWarningMessage(message, "連携を解除…");
  if (action === "連携を解除…") {
    await vscode.commands.executeCommand("novelai.revokeEditorAccess", { type: "work", work });
  }
}

/**
 * 関所と、素のエディターへの警告を仕込む。拡張機能の起動時に1回呼ぶ。
 */
export function installEditorLockGuard(registry: {
  list(): readonly WorkEntry[];
}): vscode.Disposable {
  setBodyWriteGuard(async (filePath) => {
    // 編集者モードは本文を書かない（書く道は別の仕組みで塞いである）。作者の本文だけを守る
    if (isEditorMode()) return undefined;
    const work = workOfFile(registry, filePath);
    if (!work) return undefined;
    let lock;
    try {
      lock = await editorLockOf(work, filePath);
    } catch {
      // 鍵が読めないときは書かせる側へ倒す（作者の原稿を触れなくしない）
      return undefined;
    }
    if (!lock) return undefined;
    const name = path.basename(filePath);
    useLogFile(work.folderPath);
    logFailure("編集部が校閲中のため本文への書き込みを断った", {
      話: name,
      呼び出し: callerHint(),
    });
    return describeRefusal(name, describeLock(lock));
  });

  const subscriptions: vscode.Disposable[] = [
    vscode.workspace.onDidOpenTextDocument((document) => {
      void warnAboutLockedFile(registry, document.uri, "opened").catch(() => undefined);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      void warnAboutLockedFile(registry, editor.document.uri, "opened").catch(() => undefined);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void warnAboutLockedFile(registry, document.uri, "saved").catch(() => undefined);
    }),
  ];
  return new vscode.Disposable(() => {
    setBodyWriteGuard(undefined);
    for (const item of subscriptions) item.dispose();
  });
}
