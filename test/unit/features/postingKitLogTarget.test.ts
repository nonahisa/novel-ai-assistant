import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { useLogFile } from "../../../src/core/logger";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * 投稿先を設定した記録を、**設定した作品のログ**へ書く（0.81.4）。
 *
 * 実機（2026-09-22 11:34:34）：「教科書チート_確認用 の投稿先を カクヨム に
 * しました。」が、`いじめられっ子_確認用` の操作ログに入っていた。
 * 書き先の切り替え（`useLogFile`）が失敗の道にしか無く、成功の知らせ
 * （`notifyDone` がログへも書く）は**直前に触った作品のログ**へ流れていた。
 *
 * あわせて、保存が止まったときに**何の保存だったか**もログに残す（同じ版の
 * 「外部で変更」の直し。止まった記録に操作の名前が無く、追えなかった）。
 */

vi.mock("../../../src/core/scanner", () => ({
  scanWork: async () => ({ episodes: [], manuscriptDir: "本文" }),
}));
vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => undefined,
}));

import { configurePostingSites } from "../../../src/features/postingKit";

const work: WorkEntry = {
  id: "work_log_target",
  title: "灯台の下",
  folderPath: path.join("C:", "novels", "lighthouse"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

/** 直前に触っていた、関係の無い作品 */
const otherFolder = path.join("C:", "novels", "unrelated");

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

const kakuyomuUrl = "https://kakuyomu.jp/my/works/1177354054934574437/episodes/new";

interface PickItem {
  label: string;
  [key: string]: unknown;
}

const disk = new Map<string, Uint8Array>();
/** 台帳を選択画面の途中で書き換える（ほかの操作が先に書いた、の再現） */
let touchLedgerWhilePicking = false;

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function actionsLog(folder: string): string {
  const wanted = Uri.file(path.join(folder, ".aiwriter", "logs", "actions.log")).fsPath;
  const bytes = disk.get(wanted);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

/** ログの書き込みは順番待ちの列に乗るので、何周か待つ */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  disk.clear();
  touchLedgerWhilePicking = false;
  disk.set(
    ledgerPath,
    utf8(
      JSON.stringify({
        schemaVersion: "1",
        sites: [],
        siteProfiles: [],
        posts: [],
        rankings: [],
      })
    )
  );

  workspace.textDocuments = [];
  workspace.fs = {
    createDirectory: async () => undefined,
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
    rename: async (
      from: { fsPath: string },
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (!options?.overwrite && disk.has(to.fsPath)) {
        throw new FileSystemError("exists", "FileExists");
      }
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
  } as unknown as typeof workspace.fs;

  Object.assign(window, {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async (options: { title?: string }) =>
      String(options.title ?? "").includes("新規エピソード投稿ページ")
        ? kakuyomuUrl
        : "",
    showQuickPick: async (items: PickItem[]) => {
      if (items.some((item) => "site" in item)) {
        if (touchLedgerWhilePicking) {
          disk.set(
            ledgerPath,
            utf8(JSON.stringify({ schemaVersion: "1", sites: [], posts: [{ x: 1 }] }))
          );
        }
        return items.filter((item) => item.site === "kakuyomu");
      }
      if (items.some((item) => "detailed" in item)) return items[0];
      // 基準線は引かずに終える
      return undefined;
    },
  });

  // **直前に別の作品を触っていた**（書き先はその作品を向いている）
  useLogFile(otherFolder);
});

describe("投稿先の設定の記録", () => {
  test("設定した作品のログへ書き、直前に触った作品のログへは書かない", async () => {
    const result = await configurePostingSites(work);
    await settle();

    expect(result.changed).toBe(true);
    expect(actionsLog(work.folderPath)).toContain("灯台の下 の投稿先を カクヨム にしました。");
    expect(actionsLog(otherFolder)).not.toContain("投稿先を");
  });

  test("保存が止まったら、何の保存だったかと読み込んだ時刻を残す", async () => {
    touchLedgerWhilePicking = true;

    const result = await configurePostingSites(work);
    await settle();

    expect(result.changed).toBe(false);
    const log = actionsLog(work.folderPath);
    expect(log).toContain("--- 投稿状態の保存 ---");
    expect(log).toContain("保存しようとしたもの: 投稿先の設定");
    expect(log).toMatch(/読み込んだ時刻: \d{4}-\d{2}-\d{2}T/);
  });
});
