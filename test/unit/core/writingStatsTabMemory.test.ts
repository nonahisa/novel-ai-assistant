import { describe, expect, test } from "vitest";
import {
  ALL_WORKS_TAB_KEY,
  READER_SITE_TAB_MEMORY_KEY,
  WRITING_STATS_TAB_MEMORY_KEY,
  isWritingStatsTab,
  rememberWritingStatsTab,
  rememberedWritingStatsTab,
  type TabMemento,
} from "../../../src/core/writingStatsTabMemory";

/**
 * 執筆統計の前のタブを、作品ごとに覚える（作者の判断 2026-11-01）。
 *
 * - **作品の台帳には書かない**（拡張機能の保管庫 globalState に置く）
 * - 初めての作品は「概要」
 * - 知らないタブの鍵は覚えない・覚えてあっても概要へ戻す
 * - サイトのタブは外側の1段（`site-<サイト>`。作者の指示 2026-11-01「二段のタブとせず」）
 */

function memento(initial: Record<string, unknown> = {}): TabMemento & { store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: <T>(key: string) => store[key] as T | undefined,
    update: async (key: string, value: unknown) => {
      store[key] = value;
    },
  };
}

describe("作品ごとの前のタブ", () => {
  test("初めての作品は概要", () => {
    expect(rememberedWritingStatsTab(memento(), "work_1")).toBe("overview");
  });

  test("作品ごとに別々に覚える（サイトのタブも外側のタブとして覚える）", async () => {
    const state = memento();
    await rememberWritingStatsTab(state, "work_1", "site-kakuyomu");
    await rememberWritingStatsTab(state, "work_2", "trend");
    expect(rememberedWritingStatsTab(state, "work_1")).toBe("site-kakuyomu");
    expect(rememberedWritingStatsTab(state, "work_2")).toBe("trend");
    // 覚えたのは保管庫の1つの鍵の中（作品のファイルは触らない）
    expect(Object.keys(state.store)).toEqual([WRITING_STATS_TAB_MEMORY_KEY]);
  });

  test("全作品の画面も、作品とは別の鍵で覚える", async () => {
    const state = memento();
    await rememberWritingStatsTab(state, ALL_WORKS_TAB_KEY, "trend");
    expect(rememberedWritingStatsTab(state, ALL_WORKS_TAB_KEY)).toBe("trend");
    expect(rememberedWritingStatsTab(state, "work_1")).toBe("overview");
  });

  test("知らないタブの鍵は覚えない（もう無い「読者の反応」・知らないサイトも）", async () => {
    const state = memento();
    await rememberWritingStatsTab(state, "work_1", "site-narou");
    await rememberWritingStatsTab(state, "work_1", "<script>");
    await rememberWritingStatsTab(state, "work_1", "readers");
    await rememberWritingStatsTab(state, "work_1", "site-どこか");
    expect(rememberedWritingStatsTab(state, "work_1")).toBe("site-narou");
  });

  test("タブの鍵として通すのは、固定の3つと知っているサイトのタブだけ", () => {
    for (const key of ["overview", "trend", "episodes", "site-kakuyomu", "site-alphapolis", "site-note", "site-narou"]) {
      expect(isWritingStatsTab(key), key).toBe(true);
    }
    for (const key of ["readers", "site-", "site-x", "kakuyomu", 3, null]) {
      expect(isWritingStatsTab(key), String(key)).toBe(false);
    }
  });

  test("0.119.0 で覚えた「読者の反応」＋サイトの組は、そのサイトのタブとして読み替える", () => {
    const state = memento({
      [WRITING_STATS_TAB_MEMORY_KEY]: { work_1: "readers", work_2: "readers", work_3: "readers" },
      [READER_SITE_TAB_MEMORY_KEY]: { work_1: "narou", work_3: "どこか" },
    });
    expect(rememberedWritingStatsTab(state, "work_1")).toBe("site-narou");
    // サイトを覚えていない・知らないサイトなら概要（どのサイトかは決められない）
    expect(rememberedWritingStatsTab(state, "work_2")).toBe("overview");
    expect(rememberedWritingStatsTab(state, "work_3")).toBe("overview");
  });

  test("読み替えでは保管庫へ書き戻さない（開くたびに書き込みを増やさない）", () => {
    const state = memento({
      [WRITING_STATS_TAB_MEMORY_KEY]: { work_1: "readers" },
      [READER_SITE_TAB_MEMORY_KEY]: { work_1: "kakuyomu" },
    });
    const before = JSON.stringify(state.store);
    rememberedWritingStatsTab(state, "work_1");
    expect(JSON.stringify(state.store)).toBe(before);
  });

  test("保管庫の中身が壊れていても、概要で開く", () => {
    expect(rememberedWritingStatsTab(memento({ [WRITING_STATS_TAB_MEMORY_KEY]: "壊れた値" }), "work_1")).toBe(
      "overview"
    );
    expect(
      rememberedWritingStatsTab(memento({ [WRITING_STATS_TAB_MEMORY_KEY]: { work_1: "writing" } }), "work_1")
    ).toBe("overview");
  });
});
