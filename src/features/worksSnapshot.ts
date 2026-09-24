// ログの書き先：作品が定まらない——登録簿の写しは作品ぜんたいの話で、
// どの作品の話でもないので保管庫のログへ倒す（窓の札と同じ扱い）
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import {
  WORKS_SNAPSHOT_PATH,
  buildWorksSnapshot,
  serializeWorksSnapshot,
} from "../core/worksSnapshot";
import { atomicWriteFile } from "../core/atomicWrite";
import { canRunProcesses } from "../core/runtime";
import { logLine } from "../core/logger";
import { globalStorageRoot } from "./globalStoragePath";
import { readMachineName } from "./windowCard";

/**
 * 作品の登録簿の写しを保管庫へ書く（MCP の `works.list` が読む。
 * 作者の承認、2026-09-24）。
 *
 * - **起動したときと、登録簿が変わったとき（`WorkRegistry.onDidChange`）に書く**
 * - 登録簿は窓をまたいで同じだが、変わった合図は変えた窓にしか届かない。
 *   写しは**最後に書いた窓から見た登録簿**になり、写しの `writtenBy` と
 *   `writtenAt` に、どの窓がいつ書いたかを残す
 * - **原子的に書く**（`atomicWriteFile` の指定なし＝経路①）。写しは作者の
 *   データではない（本物は `globalState`）ので、退避は取らない。書きかけを
 *   MCP が読まないよう、一時ファイルから置き換える
 * - **登録簿を書き換える道は作らない。** ここは読んで写すだけ
 *
 * **ブラウザ版では書かない**（読む相手の MCP サーバーが走らない。窓の札と同じ）。
 * **失敗しても画面には出さない**。理由はログへ残す。
 */
export interface WorksSnapshotOptions {
  /** 登録簿の作品。**渡すのは関数**——書くたびに、その時点の登録簿を読む */
  listWorks: () => readonly WorkEntry[];
  /** 登録簿が変わったとき */
  onDidChangeWorks: vscode.Event<void>;
}

export function startWorksSnapshot(
  context: vscode.ExtensionContext,
  options: WorksSnapshotOptions
): vscode.Disposable | undefined {
  if (!canRunProcesses()) return undefined;

  const target = path.join(globalStorageRoot(context), ...WORKS_SNAPSHOT_PATH);
  const extensionVersion =
    (context.extension.packageJSON as { version?: string }).version ?? "";
  // 書き込みを1本の列に並べる。**追い越されると、古い登録簿の写しが最後に残る**
  let queue: Promise<void> = Promise.resolve();

  const write = (): Promise<void> => {
    queue = queue.then(async () => {
      try {
        // **登録日の順に並べる。** `WorkRegistry.list()` は作品名の順なので、
        // そのままだと二重登録を追うとき「どちらが先に入ったか」が読みにくい
        const works = [...options.listWorks()].sort((a, b) =>
          String(a.registeredAt).localeCompare(String(b.registeredAt))
        );
        const snapshot = buildWorksSnapshot(
          works,
          {
            pid: process.pid,
            extensionVersion,
            machineName: await readMachineName(),
          },
          new Date()
        );
        await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
        await atomicWriteFile(
          target,
          new TextEncoder().encode(serializeWorksSnapshot(snapshot))
        );
      } catch (error) {
        logLine(
          "登録簿の写しを保管庫へ書けませんでした（MCP の works.list が古いままです）：" +
            (error instanceof Error ? error.message : String(error))
        );
      }
    });
    return queue;
  };

  void write();
  const watch = options.onDidChangeWorks(() => void write());
  return watch;
}
