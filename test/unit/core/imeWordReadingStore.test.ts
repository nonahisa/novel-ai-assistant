import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * IMEで打った語の読みの提案の、控えと見送りの印の読み書き（設計書6.42.2。
 * 作者の裁定、2026-10-25）。
 *
 * 確かめるのは——①壊れていたら直さずに止め、ファイルにも触らない、②書く直前に
 * 読み直して照合し、弾かれたら1度だけ読み直して足し直す。同期の扱い（控えは
 * 外し、見送りの印は同期する。作者の選択 Q2）は gitSync.test.ts が見張る。
 */

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
  IME_WORD_READINGS_IGNORE_RULE: ".aiwriter/imeWordReadings.json",
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
  loadImeReadingDismissals,
  loadImeWordReadings,
  updateImeReadingDismissals,
  updateImeWordReadings,
} from "../../../src/core/imeWordReadingStore";
import { dismissImeWord, recordImeWordEntries } from "../../../src/core/imeWordReading";
import type { WorkEntry } from "../../../src/models/types";

const work = { id: "w1", folderPath: "/w" } as WorkEntry;
const WORDS = "/w/.aiwriter/imeWordReadings.json";
const DISMISSALS = "/w/.aiwriter/imeReadingDismissals.json";

const input = {
  episode: "01.txt",
  captures: [{ word: "港", reading: "みなと", offset: 0 }],
  committed: "港へ",
  before: "古い",
  now: "2026-10-25T01:00:00Z",
};

beforeEach(() => {
  files.clear();
  events.length = 0;
});

describe("控えの同期外しは、使った作品にだけ足す（作者の裁定、2026-10-25 夜）", () => {
  const GITIGNORE = "gitignore:/w:.aiwriter/imeWordReadings.json";

  test("初めて控えを書くときは、書く前に .gitignore へ足す", async () => {
    // 控え→.gitignore の順だと、間に同期が挟まると控えが Git に入りうる
    await updateImeWordReadings(work, (file) => ({ file, result: undefined }));
    expect(events).toEqual([GITIGNORE, `write:${WORDS}`]);
  });

  test("控えが既にあれば .gitignore には触らない", async () => {
    files.set(WORDS, JSON.stringify({ version: 1, entries: [] }));
    await updateImeWordReadings(work, (file) => ({ file, result: undefined }));
    expect(events).toEqual([`write:${WORDS}`]);
  });

  test("見送りの印は同期するので、.gitignore には足さない", async () => {
    await updateImeReadingDismissals(work, (file) => file);
    expect(events).toEqual([`write:${DISMISSALS}`]);
  });
});

describe("IMEの読みの提案の控え", () => {
  test("無ければ空", async () => {
    expect(await loadImeWordReadings(work)).toEqual({
      file: { version: 1, entries: [] },
      hash: undefined,
    });
  });

  test("壊れていたら直さずに止め、ファイルにも触らない", async () => {
    files.set(WORDS, "{ 壊れた");
    await expect(loadImeWordReadings(work)).rejects.toThrow(/読めません/);
    await expect(
      updateImeWordReadings(work, (file) => ({ file, result: undefined }))
    ).rejects.toThrow(/読めません/);
    expect(files.get(WORDS)).toBe("{ 壊れた");
  });

  test("照合で弾かれたら読み直して足し直す（別の窓の回数を残す）", async () => {
    let calls = 0;
    const added = await updateImeWordReadings(work, (file) => {
      calls++;
      if (calls === 1) {
        files.set(WORDS, JSON.stringify(recordImeWordEntries(file, input).file));
      }
      const next = recordImeWordEntries(file, { ...input, now: "2026-10-25T02:00:00Z" });
      return { file: next.file, result: next.added };
    });
    expect(calls).toBe(2);
    // 2回目は別の窓の分に足したので、新しく出た語ではない
    expect(added).toEqual([]);
    expect((await loadImeWordReadings(work)).file.entries[0].count).toBe(2);
  });
});

describe("見送りの印", () => {
  test("書いた印を読み戻せる", async () => {
    await updateImeReadingDismissals(work, (file) =>
      dismissImeWord(file, { episode: "01.txt", word: "港", reading: "みなと" }, "t")
    );
    expect((await loadImeReadingDismissals(work)).file.entries).toEqual([
      { episode: "01.txt", word: "港", reading: "みなと", at: "t" },
    ]);
  });

  test("壊れていたら直さずに止める（作者の判断の記録を空で上書きしない）", async () => {
    files.set(DISMISSALS, "[]");
    await expect(
      updateImeReadingDismissals(work, (file) => file)
    ).rejects.toThrow(/読めません/);
    expect(files.get(DISMISSALS)).toBe("[]");
  });
});
