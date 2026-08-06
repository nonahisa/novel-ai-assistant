import { describe, expect, test } from "vitest";
import { countChars, stripRuby } from "../../src/core/charCount";

describe("文字数計測", () => {
  test("改行と空白を純文字数から除外し、総文字数には空白を残す", () => {
    expect(countChars("吾輩 は\r\n猫である。\n")).toEqual({
      gross: 9,
      net: 8,
      lines: 3,
      paragraphs: 1,
    });
  });

  test("Markdownルビから読みだけを除外する", () => {
    expect(stripRuby("{漢字|かんじ}と東京")).toBe("漢字と東京");
  });
});
