import { describe, expect, test } from "vitest";
import {
  ALL_WORKS_TAB_KEY,
  READER_SITE_TAB_MEMORY_KEY,
  WRITING_STATS_TAB_MEMORY_KEY,
  rememberReaderSiteTab,
  rememberWritingStatsTab,
  rememberedReaderSiteTab,
  rememberedWritingStatsTab,
  type TabMemento,
} from "../../../src/core/writingStatsTabMemory";

/**
 * 執筆統計の前のタブを、作品ごとに覚える（作者の判断 2026-11-01）。
 *
 * - **作品の台帳には書かない**（拡張機能の保管庫 globalState に置く）
 * - 初めての作品は「概要」
 * - 知らないタブの鍵は覚えない・覚えてあっても概要へ戻す
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

  test("作品ごとに別々に覚える", async () => {
    const state = memento();
    await rememberWritingStatsTab(state, "work_1", "readers");
    await rememberWritingStatsTab(state, "work_2", "trend");
    expect(rememberedWritingStatsTab(state, "work_1")).toBe("readers");
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

  test("知らないタブの鍵は覚えない", async () => {
    const state = memento();
    await rememberWritingStatsTab(state, "work_1", "readers");
    await rememberWritingStatsTab(state, "work_1", "<script>");
    expect(rememberedWritingStatsTab(state, "work_1")).toBe("readers");
  });

  test("読者の反応の中のサイトのタブも、作品ごとに覚える（外側のタブとは別の表）", async () => {
    const state = memento();
    expect(rememberedReaderSiteTab(state, "work_1")).toBeNull();
    await rememberReaderSiteTab(state, "work_1", "narou");
    await rememberReaderSiteTab(state, "work_2", "kakuyomu");
    await rememberReaderSiteTab(state, "work_1", "どこか");
    expect(rememberedReaderSiteTab(state, "work_1")).toBe("narou");
    expect(rememberedReaderSiteTab(state, "work_2")).toBe("kakuyomu");
    expect(Object.keys(state.store)).toEqual([READER_SITE_TAB_MEMORY_KEY]);
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
