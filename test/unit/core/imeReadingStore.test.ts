import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * IMEで打った読みの控え（`.aiwriter/imeReadings.json`。設計書6.42.2）の読み書き。
 *
 * 確かめるのは3つ——①無ければ空・壊れていたら直さずに投げる、②書く直前に
 * 読み直して、読んだときと違えば書かない、③照合で弾かれたら1度だけ読み直して
 * 足し直す（同期で入った別の機械の回数を押し流さない）。
 */

/** 作り物のファイルの置き場（パス → 中身） */
const files = new Map<string, string>();

vi.mock("vscode", () => ({
  FileSystemError: class extends Error {},
  workspace: {
    fs: {
      readFile: async (uri: { fsPath: string }) => {
        const text = files.get(uri.fsPath);
        if (text === undefined) {
          const error = new Error("FileNotFound") as Error & { code: string };
          error.code = "FileNotFound";
          throw error;
        }
        return new TextEncoder().encode(text);
      },
      createDirectory: async () => undefined,
    },
  },
}));

vi.mock("../../../src/core/paths", () => ({
  join: (...parts: string[]) => parts.join("/"),
  dirname: (p: string) => p.slice(0, p.lastIndexOf("/")),
  toUri: (p: string) => ({ fsPath: p }),
}));

vi.mock("../../../src/core/workRegistry", () => ({
  workPaths: () => ({ aiwriter: "/w/.aiwriter" }),
}));

vi.mock("../../../src/core/atomicWrite", () => ({
  atomicWriteFile: async (target: string, bytes: Uint8Array) => {
    files.set(target, new TextDecoder().decode(bytes));
  },
}));

import {
  ImeReadingsChangedError,
  loadImeReadings,
  saveImeReadings,
  updateImeReadings,
} from "../../../src/core/imeReadingStore";
import { recordImeReadingEntry } from "../../../src/core/imeReading";
import type { WorkEntry } from "../../../src/models/types";

const work = { id: "w1", folderPath: "/w" } as WorkEntry;
const FILE = "/w/.aiwriter/imeReadings.json";

beforeEach(() => {
  files.clear();
});

describe("IMEの読みの控え", () => {
  test("無ければ空の控え", async () => {
    const loaded = await loadImeReadings(work);
    expect(loaded).toEqual({ file: { version: 1, entries: [] }, hash: undefined });
  });

  test("壊れていたら直さずに投げ、ファイルにも触らない", async () => {
    files.set(FILE, "{ 壊れた");
    await expect(loadImeReadings(work)).rejects.toThrow(/読めません/);
    await expect(
      updateImeReadings(work, (file) => file)
    ).rejects.toThrow(/読めません/);
    expect(files.get(FILE)).toBe("{ 壊れた");
  });

  test("書いた控えを読み戻せる", async () => {
    const file = recordImeReadingEntry(
      { version: 1, entries: [] },
      { surface: "東雲", reading: "しののめ" },
      "2026-10-24T01:00:00Z"
    );
    await saveImeReadings(work, file, undefined);
    expect((await loadImeReadings(work)).file).toEqual(file);
  });

  test("読んだあとに書き換わっていたら書かない", async () => {
    const loaded = await loadImeReadings(work);
    files.set(FILE, JSON.stringify({ version: 1, entries: [] }));
    await expect(saveImeReadings(work, loaded.file, loaded.hash)).rejects.toBeInstanceOf(
      ImeReadingsChangedError
    );
  });

  test("照合で弾かれたら読み直して足し直す（別の機械の回数を残す）", async () => {
    const capture = { surface: "東雲", reading: "しののめ" };
    let calls = 0;
    const result = await updateImeReadings(work, (file) => {
      calls++;
      // 1回目の読みのあとに、別の機械の同期で1回ぶん入った
      if (calls === 1) {
        files.set(
          FILE,
          JSON.stringify(recordImeReadingEntry(file, capture, "2026-10-24T00:00:00Z"))
        );
      }
      return recordImeReadingEntry(file, capture, "2026-10-24T01:00:00Z");
    });
    expect(calls).toBe(2);
    expect(result.entries).toEqual([
      { surface: "東雲", reading: "しののめ", count: 2, lastSeen: "2026-10-24T01:00:00Z" },
    ]);
    expect(JSON.parse(files.get(FILE) ?? "")).toEqual(result);
  });
});
