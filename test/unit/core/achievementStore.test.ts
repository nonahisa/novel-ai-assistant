import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { AchievementStore } from "../../../src/core/achievementStore";
import type { Achievement } from "../../../src/core/celebrations";
import type { WorkEntry } from "../../../src/models/types";
import { FileSystemError, Uri, workspace } from "../support/vscodeStub";

/**
 * 作品の達成の記録（設計書6.3.8）。
 *
 * **読めない記録は上書きしない。** 競合マーカーが混ざった記録を「空」と
 * 読んで書き直すと、残っていた達成の印が黙って消える。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "空の港",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-03T00:00:00.000Z",
};

const logPath = Uri.file(
  path.join(work.folderPath, ".aiwriter", "achievements.json")
).fsPath;

const entry = (id: string): Achievement => ({
  id,
  kind: "work",
  day: "2026-09-23",
  at: "2026-09-23T01:00:00.000Z",
  goal: 100_000,
  written: 100_010,
  workId: work.id,
  workTitle: work.title,
});

describe("作品の達成の記録", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
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
      rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
    } as unknown as typeof workspace.fs;
  });

  test("無ければ空として読み、書き足すと残る", async () => {
    const store = new AchievementStore(work);
    expect(await store.load()).toEqual([]);
    await store.append([entry("a")]);
    await store.append([entry("a"), entry("b")]);
    expect((await store.load()).map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("壊れた記録は読めないと言い、書き足しもしない", async () => {
    const broken = new TextEncoder().encode("<<<<<<< HEAD\n{}\n=======\n");
    disk.set(logPath, broken);
    const store = new AchievementStore(work);
    await expect(store.load()).rejects.toThrow();
    await expect(store.append([entry("a")])).rejects.toThrow();
    // 元のまま（直して上書きしていない）
    expect(new TextDecoder().decode(disk.get(logPath))).toContain("<<<<<<< HEAD");
  });
});
