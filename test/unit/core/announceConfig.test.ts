import { describe, expect, test } from "vitest";
import {
  normalizeHashtag,
  parseAnnounceConfig,
  parseAnnouncementHistory,
} from "../../../src/core/announceConfig";

/**
 * 更新告知の設定と履歴の読み方（2026-10-16 に `workRegistry.ts`・`announcementHistory.ts`
 * から切り出したもの）。製品と MCP の告知文が同じ関数を通す。
 */
describe("更新告知の設定と履歴の読み方", () => {
  test("ハッシュタグは全角の＃・空白を揃え、重ねを落とす（作者の書いた順を保つ）", () => {
    expect(parseAnnounceConfig({ hashtags: ["創作", "＃創作", "# 小説"], workUrl: " https://x " })).toEqual({
      hashtags: ["#創作", "#小説"],
      workUrl: "https://x",
    });
    expect(normalizeHashtag("##＃タグ")).toBe("#タグ");
    expect(normalizeHashtag("　")).toBe("");
  });

  test("欄の型が違えば、半端に読まず丸ごと無かったことにする", () => {
    expect(parseAnnounceConfig({ hashtags: "創作" })).toBeUndefined();
    expect(parseAnnounceConfig({ workUrl: 3 })).toBeUndefined();
    expect(parseAnnounceConfig(null)).toBeUndefined();
  });

  test("履歴は文字列だけを読み、壊れていれば空", () => {
    expect(parseAnnouncementHistory(JSON.stringify(["a", 1, "b"]))).toEqual(["a", "b"]);
    expect(parseAnnouncementHistory("{")).toEqual([]);
    expect(parseAnnouncementHistory("{}")).toEqual([]);
  });
});
