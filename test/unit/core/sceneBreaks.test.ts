import { describe, expect, test } from "vitest";
import { isSceneBreakLine, sceneRanges } from "../../../src/core/sceneBreaks";

/**
 * 1話の中の場面の区切り（2026-09-25、人称のよじれの2回目）。
 *
 * 形は作者の6作品の写しで数えたもの（◆◇◆◇ など・「ーーーー」「――――――」）。
 * 台詞だけの行と「……」の行は区切りではない。
 */

describe("区切りの行", () => {
  test.each([
    "◆◇◆◇",
    "◇◆◇◆◇",
    "　◇",
    "＊＊＊",
    "***",
    "＊　＊　＊",
    "※",
    "ーーーー",
    "――――――",
    "---",
  ])("「%s」は区切り", (line) => {
    expect(isSceneBreakLine(line)).toBe(true);
  });

  test.each([
    "",
    "　",
    "……",
    "「……」",
    "「！？」",
    "――",
    "ーー！",
    "・・・",
    "◆第二章",
    "# 見出し",
  ])("「%s」は区切りではない", (line) => {
    expect(isSceneBreakLine(line)).toBe(false);
  });
});

describe("場面に割る", () => {
  test("区切りの行はどの場面にも入れない", () => {
    const lines = ["あ", "い", "◆◇◆◇", "う"];
    expect(sceneRanges(lines)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 },
    ]);
  });

  test("区切りが無ければ1つの場面", () => {
    expect(sceneRanges(["あ", "い"])).toEqual([{ start: 0, end: 2 }]);
  });

  test("区切りが続いても、空の場面は作らない", () => {
    expect(sceneRanges(["◇", "＊＊＊", "あ", "◇"])).toEqual([{ start: 2, end: 3 }]);
  });

  test("話の境（extraStarts）でも割る", () => {
    expect(sceneRanges(["あ", "い", "う", "え"], [2])).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});
