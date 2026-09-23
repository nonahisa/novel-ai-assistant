// ログの書き先：作品が定まらない——札は窓ごとで、どの作品の話でもないので
// 保管庫のログへ倒す（助言方針の控えと同じ扱い）
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import {
  WINDOW_CARD_DIRECTORY,
  WINDOW_CARD_HEARTBEAT_MS,
  buildWindowCard,
  serializeWindowCard,
  shortMachineName,
  windowCardFileName,
  worksOpenInWindow,
} from "../core/windowCard";
import { atomicWriteFile } from "../core/atomicWrite";
import { canRunProcesses } from "../core/runtime";
import { logLine } from "../core/logger";
import { globalStorageRoot } from "./globalStoragePath";

/**
 * 窓の札を保管庫へ書く（MCP の道具 `windows.list` が読む。作者の依頼、2026-09-22）。
 *
 * - **起動したときに書き、5分ごとに `updatedAt` を打ち直す。** 開いている
 *   フォルダーが変わったときも書き直す（札の中身が変わるため）
 * - **閉じるときに消す**（`close()`。`deactivate` から呼ぶ）。消せなくても、
 *   `updatedAt` が古ければ MCP が「たぶん閉じた」と印を付ける
 *
 * **置き場は `features/globalStoragePath.ts` を通す**（助言方針の控え・MCP の束の
 * 写しと同じ道）。MCP は束の居場所から同じ場所を知る（`mcp/globalStorage.ts`）。
 *
 * **ブラウザ版では書かない。** MCP サーバーはブラウザでは走らない
 * （外部プロセスを起動できない）ので、札を読む相手が居ない。
 * プロセス番号も無い。
 *
 * **札は作者のデータではない。** 窓が開いている間だけ意味のある控えなので、
 * 上書きの経路（`atomicWriteFile` の指定なし）で書き、退避は取らない
 * （実装ルール2の3経路のうち①。助言方針の控えと同じ扱い）。
 *
 * **失敗しても画面には出さない。** 作者に用のある話ではない。理由はログへ残す
 * ——残さないと、`windows.list` に窓が出ない理由を誰も追えない。
 */
export interface WindowCardHandle extends vscode.Disposable {
  /** 札を消す。**待たれないことがある**（`deactivate` の限界） */
  close(): Promise<void>;
}

/**
 * 札と「バージョンを確認」が添える、窓の名前（作者の依頼「B2」、2026-09-22 未明）。
 *
 * **2か所で同じものを出す。** MCP の `windows.list` と画面の「バージョンを確認」の
 * 中身がずれると、2台で突き合わせるときに片方にしか無い項目ができる。
 */
export interface WindowIdentity {
  /** `vscode.workspace.name`。フォルダーを開いていない窓は `null` */
  name: string | null;
  /** 開いている作品の名前（登録簿の `title`） */
  works: string[];
  /** 機械の名前（`shortMachineName`）。ブラウザ版・取れないときは `null` */
  machineName: string | null;
  /** 拡張機能開発ホスト（F5 で立ち上げた窓）か */
  developmentHost: boolean;
}

/**
 * 機械の名前。**ブラウザ版では `null`**（「どの機械か」という概念が無い）。
 *
 * `node:os` は**動的 import**で取る（CLAUDE.md 規則7）。静的に書くと、
 * ブラウザ版は拡張機能を読み込んだ瞬間に落ちる。取れなくても失敗にしない
 * ——名札が1つ欠けるだけで、版の表示を止める理由にはならない。
 */
export async function readMachineName(): Promise<string | null> {
  if (!canRunProcesses()) return null;
  try {
    const os = await import("node:os");
    return shortMachineName(os.hostname());
  } catch {
    return null;
  }
}

/** いまの窓の名前・作品・機械を集める（札と「バージョンを確認」が通す） */
export async function readWindowIdentity(
  context: vscode.ExtensionContext,
  works: readonly WorkEntry[]
): Promise<WindowIdentity> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    path.fromUri(folder.uri)
  );
  return {
    name: vscode.workspace.name ?? null,
    works: worksOpenInWindow(works, folders),
    machineName: await readMachineName(),
    developmentHost: context.extensionMode === vscode.ExtensionMode.Development,
  };
}

export interface WindowCardOptions {
  /**
   * 登録簿の作品（札の `works` を決める）。**渡すのは関数**——
   * 5分ごとの打ち直しのたびに、その時点の登録簿を読むため。
   */
  listWorks?: () => readonly WorkEntry[];
  /** 登録簿が変わったとき。札の `works` が変わるので書き直す */
  onDidChangeWorks?: vscode.Event<void>;
}

export function startWindowCard(
  context: vscode.ExtensionContext,
  options: WindowCardOptions = {}
): WindowCardHandle | undefined {
  if (!canRunProcesses()) return undefined;

  const pid = process.pid;
  const startedAt = new Date();
  const directory = path.join(globalStorageRoot(context), ...WINDOW_CARD_DIRECTORY);
  const target = path.join(directory, windowCardFileName(pid));
  const extensionVersion =
    (context.extension.packageJSON as { version?: string }).version ?? "";
  let closed = false;
  // 書き込みを1本の列に並べる。**打ち直しと消去が追い越し合うと、
  // 消したあとに札が生き返る**
  let queue: Promise<void> = Promise.resolve();

  const write = (): Promise<void> => {
    queue = queue.then(async () => {
      if (closed) return;
      try {
        const identity = await readWindowIdentity(
          context,
          options.listWorks?.() ?? []
        );
        const card = buildWindowCard({
          pid,
          extensionVersion,
          vscodeVersion: vscode.version,
          appName: vscode.env.appName,
          workspaceName: identity.name ?? undefined,
          developmentHost: identity.developmentHost,
          folders: (vscode.workspace.workspaceFolders ?? []).map((folder) =>
            path.fromUri(folder.uri)
          ),
          machineName: identity.machineName,
          works: identity.works,
          startedAt,
          now: new Date(),
        });
        await vscode.workspace.fs.createDirectory(path.toUri(directory));
        await atomicWriteFile(
          target,
          new TextEncoder().encode(serializeWindowCard(card))
        );
      } catch (error) {
        logLine(
          "窓の札を保管庫へ書けませんでした（MCP の windows.list にこの窓が出ません）：" +
            (error instanceof Error ? error.message : String(error))
        );
      }
    });
    return queue;
  };

  void write();
  const timer = setInterval(() => void write(), WINDOW_CARD_HEARTBEAT_MS);
  const folderWatch = vscode.workspace.onDidChangeWorkspaceFolders(
    () => void write()
  );
  const worksWatch = options.onDidChangeWorks?.(() => void write());

  const close = (): Promise<void> => {
    if (closed) return queue;
    closed = true;
    clearInterval(timer);
    folderWatch.dispose();
    worksWatch?.dispose();
    queue = queue.then(async () => {
      try {
        await vscode.workspace.fs.delete(path.toUri(target), {
          useTrash: false,
        });
      } catch {
        // 無い（書けていなかった）・消せない。どちらも MCP が古さで見分ける
      }
    });
    return queue;
  };

  return {
    close,
    // `context.subscriptions` から呼ばれたとき（`deactivate` より先に
    // 片づけが走ったとき）も、札は消しにいく
    dispose: () => void close(),
  };
}
