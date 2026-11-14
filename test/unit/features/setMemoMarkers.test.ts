import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import { memoMarkersOf, type MemoMarkers } from "../../../src/core/memoMarkers";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";

/**
 * 「メモの印」（設計書6.40.8。作者の決定 2026-11-14 夜）。
 *
 * - 新しくオンにする印で始まる行があれば、**切り替える前に件数と場所を見せて確かめる**
 * - 取りやめたら書き換えない。0件なら確かめずに切り替える
 * - 設定が壊れていれば、直さずに止める（実装ルール2）
 * - 本文のファイルには触らない（読むだけ）
 */

const state = vi.hoisted(() => ({
  current: undefined as unknown,
  readError: undefined as Error | undefined,
  written: [] as string[][],
  texts: new Map<string, string>(),
}));

vi.mock("../../../src/core/memoMarkerStore", () => ({
  readMemoMarkers: async () => {
    if (state.readError) throw state.readError;
    return state.current;
  },
  writeMemoMarkers: async (_work: unknown, ids: string[]) => {
    state.written.push([...ids]);
    return state.current;
  },
}));

vi.mock("../../../src/core/scanner", () => ({
  scanWork: async () => ({
    episodes: [...state.texts.keys()].map(
      (filePath, index) =>
        ({
          filePath,
          fileName: filePath.split("/").pop(),
          // 本物の話は kind を必ず持つ（無いと見出しが「undefined1」になる）。題は無い話もある
          kind: "本編",
          subtitle: null,
          metaTitle: null,
          date: null,
          chapterStart: index + 1,
          chapterEnd: index + 1,
          hasConflictMarkers: false,
        }) as unknown as EpisodeFile
    ),
  }),
}));

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: async (filePath: string) => ({ text: state.texts.get(filePath) ?? "" }),
}));

vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => undefined,
}));

const { setMemoMarkers, findMarkedLines } = await import("../../../src/features/setMemoMarkers");

const WORK: WorkEntry = {
  id: "work_memo",
  title: "仮作品",
  folderPath: "C:/novelai-test/仮作品",
  registeredAt: "2026-11-14T00:00:00.000Z",
};

const original = {
  quickPick: window.showQuickPick,
  warning: window.showWarningMessage,
  error: window.showErrorMessage,
  info: window.showInformationMessage,
};

let warnings: Array<{ message: string; detail?: string }>;
let errors: string[];
/** 確かめの窓で押すボタン（undefined は取りやめ） */
let answer: string | undefined;
/** 選ぶ窓で選ぶ印 */
let pick: string[];

beforeEach(() => {
  state.current = memoMarkersOf(["slash"]);
  state.readError = undefined;
  state.written = [];
  state.texts = new Map([
    ["本文/001.txt", "　本文。\n%% 付箋のつもり\n　続き。\n<!-- 囲み"],
    ["本文/002.txt", "　二話目。\n％％ 全角の付箋"],
  ]);
  warnings = [];
  errors = [];
  answer = "切り替える";
  pick = ["slash", "percent"];
  window.showQuickPick = (async (items: unknown) =>
    (items as Array<{ markerId: string }>).filter((item) => pick.includes(item.markerId))) as typeof window.showQuickPick;
  window.showWarningMessage = (async (message: string, options?: { detail?: string }) => {
    warnings.push({ message, detail: typeof options === "object" ? options?.detail : undefined });
    return answer;
  }) as unknown as typeof window.showWarningMessage;
  window.showErrorMessage = (async (message: string) => {
    errors.push(message);
    return undefined;
  }) as typeof window.showErrorMessage;
  window.showInformationMessage = (async () => undefined) as typeof window.showInformationMessage;
});

afterEach(() => {
  window.showQuickPick = original.quickPick;
  window.showWarningMessage = original.warning;
  window.showErrorMessage = original.error;
  window.showInformationMessage = original.info;
});

describe("切り替える前の数え上げ", () => {
  test("新しくオンにする印で始まる行を、話と行で数える", async () => {
    const found = await findMarkedLines(WORK, memoMarkersOf(["percent"]));
    expect(found.places).toEqual(["第1話 2行目", "第2話 2行目"]);
    // 囲みは <!-- で始まる行（閉じていなくても数える）
    expect((await findMarkedLines(WORK, memoMarkersOf(["comment"]))).places).toEqual(["第1話 4行目"]);
  });

  test("件数と場所を見せて確かめ、押せば書く", async () => {
    const result = await setMemoMarkers(WORK);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].detail).toContain("2か所");
    expect(warnings[0].detail).toContain("第1話 2行目");
    expect(warnings[0].detail).toContain("字数・投稿用のコピー・書き出しから外れます");
    expect(state.written).toEqual([["slash", "percent"]]);
    expect((result as MemoMarkers).ids).toEqual(["slash", "percent"]);
  });

  test("取りやめたら書き換えない", async () => {
    answer = undefined;
    expect(await setMemoMarkers(WORK)).toBeUndefined();
    expect(state.written).toEqual([]);
  });

  test("0件なら確かめずに切り替える", async () => {
    pick = ["slash", "backslash"];
    await setMemoMarkers(WORK);
    expect(warnings).toEqual([]);
    expect(state.written).toEqual([["slash", "backslash"]]);
  });

  test("外すだけなら確かめない（本文へ戻る行は、字数が増えるだけ）", async () => {
    state.current = memoMarkersOf(["slash", "percent"]);
    pick = ["slash"];
    await setMemoMarkers(WORK);
    expect(warnings).toEqual([]);
    expect(state.written).toEqual([["slash"]]);
  });
});

describe("選び方と設定の壊れ", () => {
  test("1つも選ばなければ書き換えない", async () => {
    pick = [];
    expect(await setMemoMarkers(WORK)).toBeUndefined();
    expect(state.written).toEqual([]);
    expect(warnings[0].message).toContain("1つ以上");
  });

  test("同じ組なら何もしない", async () => {
    pick = ["slash"];
    expect(await setMemoMarkers(WORK)).toBeUndefined();
    expect(state.written).toEqual([]);
  });

  test("壊れた設定は直さずに止め、理由を出す", async () => {
    state.readError = new Error("作品設定を読み込めません: Unexpected token");
    expect(await setMemoMarkers(WORK)).toBeUndefined();
    expect(state.written).toEqual([]);
    expect(errors[0]).toContain("Unexpected token");
  });
});
