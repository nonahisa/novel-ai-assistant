import { describe, expect, test } from "vitest";
import {
  CHAPTERS_SCHEMA_VERSION,
  findChapterStartingAt,
  parseChapterSet,
  withChapterStartingAt,
  withoutChapterStartingAt,
} from "../../src/models/chapter";

/**
 * 章の台帳の形（設計書6.66.1）。
 *
 * 章は「名前」と「どの話から始まるか」だけを持つ。**作者が手で開いて
 * 直すJSON**なので、読めない形なら黙って直さずに止める。
 */

describe("章立てJSONの検証", () => {
  test("名前と開始の話がそろっていれば読める", () => {
    const set = parseChapterSet({
      schemaVersion: "1",
      chapters: [{ name: "第一章　出立", startEpisodePath: "本文/001.txt" }],
    });

    expect(set.chapters).toEqual([
      { name: "第一章　出立", startEpisodePath: "本文/001.txt" },
    ]);
  });

  test("章が1つも無い台帳も読める", () => {
    expect(parseChapterSet({ chapters: [] }).chapters).toEqual([]);
    // 版が書かれていなければ、いまの版として扱う
    expect(parseChapterSet({ chapters: [] }).schemaVersion).toBe(
      CHAPTERS_SCHEMA_VERSION
    );
  });

  test("区切りが `\\` で書かれていても `/` へ揃える", () => {
    // 手元のWindowsで書かれた指定を、ブラウザ版でも同じ話として引けるように
    const set = parseChapterSet({
      chapters: [{ name: "第一章", startEpisodePath: "本文\\001.txt" }],
    });

    expect(set.chapters[0].startEpisodePath).toBe("本文/001.txt");
  });

  test("名前が空の章は受け付けない", () => {
    expect(() =>
      parseChapterSet({
        chapters: [{ name: "   ", startEpisodePath: "本文/001.txt" }],
      })
    ).toThrow();
  });

  test("開始の話が空の章は受け付けない", () => {
    expect(() =>
      parseChapterSet({ chapters: [{ name: "第一章", startEpisodePath: "" }] })
    ).toThrow();
  });

  test("同じ話から始まる章が2つあれば読めないと言って止まる", () => {
    // 後勝ちで畳むと、作者が付けたもう片方の章名が黙って消える
    expect(() =>
      parseChapterSet({
        chapters: [
          { name: "第一章", startEpisodePath: "本文/001.txt" },
          { name: "序の章", startEpisodePath: "本文/001.txt" },
        ],
      })
    ).toThrow(/本文\/001\.txt/);
  });

  test("章の一覧が配列でなければ止まる", () => {
    expect(() => parseChapterSet({ chapters: "第一章" })).toThrow();
  });
});

describe("章の足し方・外し方", () => {
  const chapters = [
    { name: "第一章", startEpisodePath: "本文/001.txt" },
    { name: "第二章", startEpisodePath: "本文/006.txt" },
  ];

  test("新しい話から章を始めると、末尾に足される", () => {
    const next = withChapterStartingAt(chapters, "本文/010.txt", "第三章");

    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({
      name: "第三章",
      startEpisodePath: "本文/010.txt",
    });
    // 元の配列は書き換えない（保存に失敗したら画面も元のまま）
    expect(chapters).toHaveLength(2);
  });

  test("既にその話から始まる章があれば、改名として扱う", () => {
    const next = withChapterStartingAt(chapters, "本文/006.txt", "第二章　邂逅");

    expect(next).toHaveLength(2);
    expect(findChapterStartingAt(next, "本文/006.txt")?.name).toBe(
      "第二章　邂逅"
    );
  });

  test("区切りが `\\` でも同じ話として扱う", () => {
    const next = withChapterStartingAt(chapters, "本文\\006.txt", "第二章　邂逅");

    expect(next).toHaveLength(2);
  });

  test("章を外しても、ほかの章は残る", () => {
    const next = withoutChapterStartingAt(chapters, "本文/001.txt");

    expect(next).toEqual([
      { name: "第二章", startEpisodePath: "本文/006.txt" },
    ]);
  });

  test("名前が空のままでは足せない", () => {
    expect(() => withChapterStartingAt(chapters, "本文/010.txt", "  ")).toThrow();
  });
});
