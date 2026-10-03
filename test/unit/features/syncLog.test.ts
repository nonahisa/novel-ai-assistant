import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  useLogFile: vi.fn(),
}));

import { LIBRARY_LOG_IGNORE, useSyncLog } from "../../../src/features/syncLog";
import { logFailure, useLogFile } from "../../../src/core/logger";
import { workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 書庫のログの置き場（設計書5.7.9「書庫のログ」）。
 *
 * 書庫の直下には、こちらが整える `.gitignore` が無い。ログを書く前に、
 * ログの置き場の中へ `*` だけの `.gitignore` を置き、同期の記録そのものが
 * 「送り残し」にならないようにする。
 */

const works: WorkEntry[] = [
  { id: "w1", title: "いじめられっ子", folderPath: "C:/書庫/いじめられっ子" },
  { id: "w2", title: "ハイエルフ未亡人", folderPath: "C:/書庫/ハイエルフ未亡人" },
] as WorkEntry[];

let disk: Map<string, string>;
let failWrite: boolean;

const norm = (key: string) => key.replace(/\\/g, "/");
const ignoreKey = () =>
  [...disk.keys()].find((key) => norm(key).endsWith("書庫/.aiwriter/logs/.gitignore"));

beforeEach(() => {
  disk = new Map();
  failWrite = false;
  vi.mocked(useLogFile).mockClear();
  vi.mocked(logFailure).mockClear();
  workspace.fs = {
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) throw new Error("FileNotFound");
      return { type: 1 };
    },
    createDirectory: async () => undefined,
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      if (failWrite) throw new Error("NoPermissions");
      disk.set(uri.fsPath, new TextDecoder().decode(bytes));
    },
  } as unknown as typeof workspace.fs;
});

describe("書庫のログ", () => {
  test("書庫なら、Gitから外す印を置いてから書庫の直下へ向ける", async () => {
    await useSyncLog("C:/書庫", works);
    expect(ignoreKey()).toBeDefined();
    expect(disk.get(ignoreKey() as string)).toBe(LIBRARY_LOG_IGNORE);
    expect(vi.mocked(useLogFile).mock.calls).toEqual([["C:/書庫"]]);
  });

  test("印が既にあれば書き換えない（作者が置いたものかもしれない）", async () => {
    await useSyncLog("C:/書庫", works);
    const key = ignoreKey() as string;
    disk.set(key, "作者の中身\n");
    await useSyncLog("C:/書庫", works);
    expect(disk.get(key)).toBe("作者の中身\n");
  });

  test("印を置けなければ、書庫の直下へは書かず先頭の作品のログへ倒す", async () => {
    failWrite = true;
    await useSyncLog("C:/書庫", works);
    expect(vi.mocked(useLogFile).mock.calls).toEqual([[works[0].folderPath]]);
    expect(logFailure).toHaveBeenCalledTimes(1);
  });

  test("作品ごとに分けたリポジトリなら、印を置かずに作品のログ", async () => {
    await useSyncLog("C:/書庫/いじめられっ子", [works[0]]);
    expect(disk.size).toBe(0);
    expect(vi.mocked(useLogFile).mock.calls).toEqual([[works[0].folderPath]]);
  });
});
