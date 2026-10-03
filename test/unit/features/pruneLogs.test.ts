import { beforeEach, describe, expect, test } from "vitest";
import { pruneAllLogs } from "../../../src/features/pruneLogs";
import { workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * ログの掃除（`novelai.logs.retentionDays`。設計書8.3）は、
 * **書庫のログ**（設計書5.7.9）にも効く。
 */

const works: WorkEntry[] = [
  { id: "w1", title: "いじめられっ子", folderPath: "C:/書庫/いじめられっ子" },
  { id: "w2", title: "ハイエルフ未亡人", folderPath: "C:/書庫/ハイエルフ未亡人" },
] as WorkEntry[];

let disk: Map<string, string>;
// 手元の道は区切りが `\`、ドライブ名が小文字になって届く
const norm = (key: string) => key.replace(/\\/g, "/").toLowerCase();

beforeEach(() => {
  disk = new Map();
  workspace.fs = {
    readFile: async (uri: { fsPath: string }) => {
      const found = [...disk.entries()].find(([key]) => norm(key) === norm(uri.fsPath));
      if (!found) throw new Error("FileNotFound");
      return new TextEncoder().encode(found[1]);
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(norm(uri.fsPath), new TextDecoder().decode(bytes));
    },
  } as unknown as typeof workspace.fs;
});

describe("書庫のログの掃除", () => {
  test("書庫の直下の同期の記録も、保存日数を過ぎた行を落とす", async () => {
    const key = "c:/書庫/.aiwriter/logs/actions.log";
    disk.set(key, "[2000-01-01 10:00:00] 古い記録\n[2999-01-01 10:00:00] 新しい記録");
    const removed = await pruneAllLogs(works);
    expect(removed).toBe(1);
    expect(disk.get(key)).toBe("[2999-01-01 10:00:00] 新しい記録");
  });
});
