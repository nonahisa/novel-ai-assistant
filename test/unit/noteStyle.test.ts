import { describe, expect, it } from "vitest";
import { isNoteStyleTarget } from "../../src/core/noteStyle";

/**
 * note風にする原稿の見分け（設計書6.69）。
 *
 * **小説の原稿を1つも巻き込まないこと**が、この判定のいちばんの役目である。
 * 縦書きで書いている長編の表示が変わったら、それは不具合として届く。
 */
describe("note風にする原稿", () => {
  it("SNS記事の .md は note風にする", () => {
    expect(isNoteStyleTarget("C:/works/記事/2026-09-04.md", "sns")).toBe(true);
    // 日付名でなくても、作品がSNS記事なら対象（題だけのファイル）
    expect(isNoteStyleTarget("C:/works/記事/はじめに.md", "sns")).toBe(true);
  });

  /**
   * **`.txt` は投稿サイトの記法のまま保つ決まり**（設計書6.12）で、
   * noteへ貼る形でもない。記法の判定（`notationModeFor`）と足並みを揃える。
   */
  it("SNS記事でも .txt は対象にしない", () => {
    expect(isNoteStyleTarget("C:/works/記事/2026-09-04.txt", "sns")).toBe(false);
  });

  it("小説・脚本の原稿は対象にしない", () => {
    expect(isNoteStyleTarget("C:/works/本文/001_旅立ち.md", "long")).toBe(false);
    expect(isNoteStyleTarget("C:/works/本文/001_旅立ち.md", "short")).toBe(false);
    expect(isNoteStyleTarget("C:/works/本文/001_旅立ち.txt", "epic")).toBe(false);
  });

  /**
   * 形式が書かれていない作品（プロットが無い・`## 形式` が空）では、
   * **日付名という形そのものがSNS記事の印**である（設計書6.4.6）。
   * ここを落とすと、プロットを書いていない作者には何も起きない。
   */
  it("形式が分からないときは、日付名の .md だけを対象にする", () => {
    expect(isNoteStyleTarget("C:/works/記事/2026-09-04.md")).toBe(true);
    expect(isNoteStyleTarget("C:/works/記事/2026-09-04_海辺の話.md")).toBe(true);
    expect(isNoteStyleTarget("C:/works/本文/001_旅立ち.md")).toBe(false);
    expect(isNoteStyleTarget("C:/works/本文/第3話 再会.md")).toBe(false);
  });

  /** 実在しない日付は日付ではない（episodeParser と同じ判断を借りる） */
  it("実在しない日付は、日付名として扱わない", () => {
    expect(isNoteStyleTarget("C:/works/本文/2026-13-01.md")).toBe(false);
  });
});
