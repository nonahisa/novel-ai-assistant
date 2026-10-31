import { describe, expect, test } from "vitest";
import {
  announceWorkUrlDraft,
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

/**
 * 「SNS告知設定」の作品URLの欄の初期値（2026-10-25 の実機確認）。
 * 作者用の投稿ページが入って告知に載ったので、組み立てられるなら読者向けの作品ページを出す。
 */
describe("作品URLの欄の初期値", () => {
  const reader = "https://kakuyomu.jp/works/1177354054934574437";
  const author = "https://kakuyomu.jp/my/works/1177354054934574437/episodes/new";

  test("保存してある値は、作者用のページでもそのまま出す（書き換えない）", () => {
    expect(announceWorkUrlDraft(author, [reader])).toBe(author);
    expect(announceWorkUrlDraft("https://example.com/w", [reader])).toBe("https://example.com/w");
  });

  test("空なら、台帳から組み立てた読者向けの作品ページが1つに決まるときだけ出す", () => {
    expect(announceWorkUrlDraft("", [reader])).toBe(reader);
    expect(announceWorkUrlDraft("  ", [reader])).toBe(reader);
    expect(announceWorkUrlDraft("", [])).toBe("");
    // どのサイトへ誘導したいかは作者が決める（勝手に1つを選ばない）
    expect(
      announceWorkUrlDraft("", [reader, "https://ncode.syosetu.com/n1234ab/"])
    ).toBe("");
  });

  test("台帳の候補が作者用のページなら、読者向けへ直してから出す（直せなければ出さない）", () => {
    expect(announceWorkUrlDraft("", [author])).toBe(reader);
    expect(announceWorkUrlDraft("", [author, reader])).toBe(reader);
    expect(
      announceWorkUrlDraft("", ["https://www.alphapolis.co.jp/mypage/novel/save_episode/123456789"])
    ).toBe("");
  });
});
