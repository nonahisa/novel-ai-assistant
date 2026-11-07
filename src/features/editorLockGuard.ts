import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { reviewLockDetailFor } from "./manuscriptReviewLock";
import { editorLockOf, onLockLedgerWritten } from "../core/fileLockStore";
import { isEditorMode } from "../core/actorContext";
import { setBodyWriteGuard } from "../core/textFile";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { refreshEditorLocksOnOpen } from "./editorLockRefresh";
import { SessionReadonlyKeeper, type ActiveEditorView } from "./editorLockReadonly";

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
 *   保存された版は、編集部の版を守るため送り直しの対象から外れる。
 *   0.139.0 からは、前に出たときにこの窓のあいだだけ読み取り専用にする（`editorLockReadonly.ts`。
 *   作者の裁定 2026-11-07）。読み取り専用は VS Code の側の守りで、拡張機能の外からは解けるので、
 *   警告は残す
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
    `「${fileName}」は編集者が校閲中のため、書き込めません（${lockText}）。` +
    "編集者と連絡がつかないときは、「編集者連携を解除」で解けます。"
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
  logStep(`編集者が校閲中の話を素のエディターで${kind === "opened" ? "開いた" : "保存した"}: ${name}`);
  /*
    開いたときの文は、0.139.0 で読み取り専用にした今の動きに合わせる（0.140.1）。名前は帯と同じ
    GitHub の名前（`reviewLockDetailFor`。鍵の holder の git の名前は出さない）
  */
  const message =
    kind === "opened"
      ? `「${name}」は編集者が校閲中のため、読み取り専用にしました（${await reviewLockDetailFor(work, lock)}）。`
      : `「${name}」を保存しました。この話は編集者が校閲中のため、編集者へは送り直されません` +
        "（校閲が終わったあとの送り直しで、作者の版が反映されます）。";
  const action = await vscode.window.showWarningMessage(message, "連携を解除…");
  if (action === "連携を解除…") {
    await vscode.commands.executeCommand("novelai.revokeEditorAccess", { type: "work", work });
  }
}

/**
 * 前に出ているタブ（素のテキストエディターか、それ以外か）。読み取り専用の命令の当たる先。
 * 差分の画面・設定の画面などは undefined（読み取り専用にも、解く相手にもしない）
 */
function activeEditorView(): ActiveEditorView | undefined {
  try {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputText) return { uri: input.uri.toString(), kind: "text" };
    if (input instanceof vscode.TabInputCustom) return { uri: input.uri.toString(), kind: "other" };
    return undefined;
  } catch {
    // タブの一覧を持たない環境（試験の代役など）では、前の素のエディターだけを見る
    const editor = vscode.window.activeTextEditor;
    return editor ? { uri: editor.document.uri.toString(), kind: "text" } : undefined;
  }
}

/** 話（.txt・.md）を開いたら、その作品の鍵の台帳を取りに行く（作者モードで、渡している作品だけ） */
function refreshLocksFor(registry: { list(): readonly WorkEntry[] }, uri: vscode.Uri): void {
  // git の画面（差分の左側など）も同じ場所の文書として開く知らせが鳴るので、ファイルだけを見る
  if (isEditorMode() || uri.scheme !== "file" || !/\.(txt|md)$/i.test(uri.path)) return;
  const work = workOfFile(registry, path.fromUri(uri));
  if (!work) return;
  void refreshEditorLocksOnOpen(work).catch(() => undefined);
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
    logFailure("編集者が校閲中のため本文への書き込みを断った", {
      話: name,
      呼び出し: callerHint(),
    });
    return describeRefusal(name, await reviewLockDetailFor(work, lock));
  });

  const keeper = new SessionReadonlyKeeper({
    active: activeEditorView,
    isLocked: async (uriText) => {
      if (isEditorMode()) return false;
      const filePath = path.fromUri(vscode.Uri.parse(uriText));
      const work = workOfFile(registry, filePath);
      return work ? (await editorLockOf(work, filePath)) !== undefined : false;
    },
    execute: (command) => vscode.commands.executeCommand(command),
  });
  const settleReadonly = (): void => void keeper.settle();

  const subscriptions: Array<{ dispose(): unknown }> = [
    vscode.workspace.onDidOpenTextDocument((document) => {
      // 話を開いたら、その作品の鍵の台帳を取りに行く（原稿エディターで開いたときも、ここが鳴る）
      refreshLocksFor(registry, document.uri);
      /*
        **ここでは警告を出さない**（0.140.1。Mac の実機で、原稿エディターで開いても素のエディター用の
        知らせが出た）。原稿エディターで開いても同じ文書の open が鳴るため。原稿エディターには帯がある。
        素のエディターで開いたときは、前に出たときの知らせ（下の onDidChangeActiveTextEditor）で出す
      */
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      settleReadonly();
      if (!editor) return;
      refreshLocksFor(registry, editor.document.uri);
      void warnAboutLockedFile(registry, editor.document.uri, "opened").catch(() => undefined);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void warnAboutLockedFile(registry, document.uri, "saved").catch(() => undefined);
    }),
    // 鍵が届いた・外れた（どの道でも）。前にいる画面を合わせ直す
    onLockLedgerWritten(settleReadonly),
  ];
  /*
    原稿エディター（カスタムエディター）が前に出たときは onDidChangeActiveTextEditor が
    鳴らない（素のエディターでないので）。前に出たタブの知らせで、解き待ちの読み取り専用を解く
  */
  const tabs = vscode.window.tabGroups as typeof vscode.window.tabGroups | undefined;
  if (tabs?.onDidChangeTabs) subscriptions.push(tabs.onDidChangeTabs(settleReadonly));
  settleReadonly();
  return new vscode.Disposable(() => {
    setBodyWriteGuard(undefined);
    for (const item of subscriptions) item.dispose();
  });
}
