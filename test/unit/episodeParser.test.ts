import { describe, expect, test } from "vitest";
import {
  formatChapterNumber,
  nextChapterNumber,
  parseEpisodeFileName,
  sanitizeFileName,
} from "../../src/core/episodeParser";

describe("話数ファイル名", () => {
  test.each([
    ["001.txt", 1, 1, null, "本編", true],
    ["003-005_合本.txt", 3, 5, "合本", "本編", false],
    ["第１２話 再会.md", 12, 12, "再会", "本編", false],
    ["episode_0007.txt", 7, 7, null, "本編", true],
    ["幕間2.txt", 2, 2, null, "幕間", false],
  ] as const)("%s を解析する", (name, start, end, subtitle, kind, initial) => {
    const parsed = parseEpisodeFileName(name);
    expect(parsed).toMatchObject({
      chapterStart: start,
      chapterEnd: end,
      subtitle,
      kind,
      isInitialName: initial,
    });
  });

  test("既存範囲の最大話数の次を提案する", () => {
    expect(
      nextChapterNumber([
        parseEpisodeFileName("001.txt"),
        parseEpisodeFileName("003-005_合本.txt"),
      ])
    ).toBe(6);
    expect(formatChapterNumber(6, 3)).toBe("006");
  });

  test("Windowsで使用できない文字を除去する", () => {
    expect(sanitizeFileName('第1話:「始まり?」.txt')).toBe(
      "第1話：「始まり？」.txt"
    );
  });
});
