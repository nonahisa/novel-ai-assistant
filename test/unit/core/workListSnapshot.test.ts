import { describe, expect, test } from "vitest";
import {
  WORK_LIST_SNAPSHOT_KEY,
  buildWorkListSnapshot,
  parseWorkListSnapshot,
  readWorkListSnapshot,
  snapshotEntryFor,
  type WorkListSnapshotEntry,
} from "../../../src/core/workListSnapshot";
import type { WorkEntry } from "../../../src/models/types";

/**
 * **作品一覧の控え**（引継ぎ書「ノートPCの作品一覧が遅い件」）。
 *
 * 起動のたびに19作品・約590ファイルを読み終えるまで一覧が出ず、ノートPCで
 * 14〜105秒かかっていた。前回の一覧を控えておき、開いた瞬間にそれを出す。
 * ここで見るのは控えの読み書きだけ（出し方は views の試験）。
 */

const entry = (over: Partial<WorkListSnapshotEntry> = {}): WorkListSnapshotEntry => ({
  id: "a",
  folderPath: "C:/novels/a",
  fileCount: 12,
  totals: { gross: 120, net: 100, lines: 30, paragraphs: 10, manuscriptLines: 8 },
  conflictedCount: 0,
  ...over,
});

const work = (over: Partial<WorkEntry> = {}): WorkEntry => ({
  id: "a",
  title: "作品A",
  folderPath: "C:/novels/a",
  registeredAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("控えの組み立てと読み戻し", () => {
  test("組んだ控えをそのまま読み戻せる", () => {
    const built = buildWorkListSnapshot([entry(), entry({ id: "b", folderPath: "C:/novels/b" })], "2026-10-01T00:00:00.000Z");
    const parsed = parseWorkListSnapshot(JSON.parse(JSON.stringify(built)));
    expect(parsed.size).toBe(2);
    expect(parsed.get("a")).toEqual(entry());
  });

  test("形式と種類も持ち越す（右クリックの絞り込みに要る）", () => {
    const built = buildWorkListSnapshot([entry({ format: "memo", kind: "essay" })], "t");
    expect(parseWorkListSnapshot(built).get("a")).toMatchObject({ format: "memo", kind: "essay" });
  });

  test("知らない形式・種類は捨てる（行は残す）", () => {
    const raw = { version: 1, savedAt: "t", works: [{ ...entry(), format: "謎", kind: 3 }] };
    const parsed = parseWorkListSnapshot(raw).get("a");
    expect(parsed).toBeDefined();
    expect(parsed?.format).toBeUndefined();
    expect(parsed?.kind).toBeUndefined();
  });
});

describe("控えが壊れていても止まらない", () => {
  test.each([
    ["無い", undefined],
    ["null", null],
    ["文字列", "壊れた"],
    ["配列", []],
    ["版が違う", { version: 99, works: [entry()] }],
    ["works が配列でない", { version: 1, works: "x" }],
  ])("%s → 空", (_name, raw) => {
    expect(parseWorkListSnapshot(raw).size).toBe(0);
  });

  test("壊れた行だけを捨て、ほかは使う", () => {
    const raw = {
      version: 1,
      savedAt: "t",
      works: [
        entry(),
        { id: "b" },
        null,
        { ...entry({ id: "c", folderPath: "C:/c" }), fileCount: -1 },
        { ...entry({ id: "d", folderPath: "C:/d" }), totals: { net: "100" } },
      ],
    };
    const parsed = parseWorkListSnapshot(raw);
    expect([...parsed.keys()]).toEqual(["a"]);
  });

  test("保管庫の読み出しが投げても空で返す", () => {
    const store = {
      get: () => {
        throw new Error("壊れています");
      },
      update: async () => undefined,
    };
    expect(readWorkListSnapshot(store).size).toBe(0);
  });

  test("保管庫からは決まった鍵で読む", () => {
    const keys: string[] = [];
    const store = {
      get: (key: string) => {
        keys.push(key);
        return buildWorkListSnapshot([entry()], "t");
      },
      update: async () => undefined,
    };
    expect(readWorkListSnapshot(store).size).toBe(1);
    expect(keys).toEqual([WORK_LIST_SNAPSHOT_KEY]);
  });
});

describe("登録簿との突き合わせ", () => {
  test("同じIDで同じ場所なら使う", () => {
    const map = parseWorkListSnapshot(buildWorkListSnapshot([entry()], "t"));
    expect(snapshotEntryFor(work(), map)?.fileCount).toBe(12);
  });

  test("場所が変わっていれば使わない（別のフォルダーの数字を出さない）", () => {
    const map = parseWorkListSnapshot(buildWorkListSnapshot([entry()], "t"));
    expect(snapshotEntryFor(work({ folderPath: "D:/移した/a" }), map)).toBeUndefined();
  });

  test("控えに無い作品は undefined", () => {
    const map = parseWorkListSnapshot(buildWorkListSnapshot([entry()], "t"));
    expect(snapshotEntryFor(work({ id: "新しい" }), map)).toBeUndefined();
  });
});
