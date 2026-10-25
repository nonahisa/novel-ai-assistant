import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * IMEで打った読みの控え（`.aiwriter/imeReadings.json`。設計書6.42.2）の読み書き。
 *
 * 確かめるのは3つ——①無ければ空・壊れていたら直さずに投げる、②書く直前に
 * 読み直して、読んだときと違えば書かない、③照合で弾かれたら1度だけ読み直して
 * 足し直す（同じ作品を開いた別の窓の回数を押し流さない）。④同期から外す
 * 行は、控えを初めて書く前にその作品の .gitignore へだけ足す（作者の裁定、
 * 2026-10-24 夜「同期から外す」、2026-10-26「使った作品だけに足す」）。
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

/** 書いた順の記録（.gitignore を足すのが控えより先かを見る） */
const events: string[] = [];

vi.mock("../../../src/core/workRegistry", () => ({
  workPaths: () => ({ root: "/w", aiwriter: "/w/.aiwriter" }),
  IME_READINGS_IGNORE_RULE: ".aiwriter/imeReadings.json",
  ensureOnUseIgnoreRule: async (folder: string, rule: string) => {
    events.push(`gitignore:${folder}:${rule}`);
  },
}));

vi.mock("../../../src/core/atomicWrite", () => ({
  atomicWriteFile: async (target: string, bytes: Uint8Array) => {
    events.push(`write:${target}`);
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
  events.length = 0;
});

describe("控えの同期外しは、使った作品にだけ足す（作者の裁定、2026-10-26）", () => {
  /*
    これまでは起動のたびに全作品の .gitignore へ足していた（`IGNORED_PATHS`）。
    語の控え（imeWordReadings.json、0.111.18）と同じく、控えを初めて書く
    作品にだけ足す
  */
  const GITIGNORE = "gitignore:/w:.aiwriter/imeReadings.json";

  test("初めて控えを書くときは、書く前に .gitignore へ足す", async () => {
    // 控え→.gitignore の順だと、間に同期が挟まると控えが Git に入りうる
    await updateImeReadings(work, (file) => file);
    expect(events).toEqual([GITIGNORE, `write:${FILE}`]);
  });

  test("控えが既にあれば .gitignore には触らない", async () => {
    files.set(FILE, JSON.stringify({ version: 1, entries: [] }));
    await updateImeReadings(work, (file) => file);
    expect(events).toEqual([`write:${FILE}`]);
  });
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

  test("照合で弾かれたら読み直して足し直す（別の窓の回数を残す）", async () => {
    const capture = { surface: "東雲", reading: "しののめ" };
    let calls = 0;
    const result = await updateImeReadings(work, (file) => {
      calls++;
      // 1回目の読みのあとに、同じ作品を開いた別の窓から1回ぶん入った
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
