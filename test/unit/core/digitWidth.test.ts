import { describe, expect, test } from "vitest";
import {
  DIGIT_WIDTH_FULL,
  DIGIT_WIDTH_HALF,
  digitWidthReplacement,
  isDigitWidthTarget,
  isFullWidthDigit,
  isHalfWidthDigit,
  toFullWidthDigit,
  toHalfWidthDigit,
} from "../../src/core/digitWidth";

describe("半角と全角の数字の行き来", () => {
  test("0〜9のすべてを往復できる", () => {
    for (let digit = 0; digit <= 9; digit++) {
      const half = String(digit);
      const full = toFullWidthDigit(half);
      expect(full).not.toBe(half);
      expect(isFullWidthDigit(full)).toBe(true);
      expect(toHalfWidthDigit(full)).toBe(half);
    }
  });

  test("数字以外はそのまま返す", () => {
    for (const char of ["月", "A", "Ａ", "　", "", "ー"]) {
      expect(toFullWidthDigit(char)).toBe(char);
      expect(toHalfWidthDigit(char)).toBe(char);
    }
  });

  test("2文字以上は数字と見なさない（1文字ずつ扱うための関数）", () => {
    expect(isHalfWidthDigit("12")).toBe(false);
    expect(isFullWidthDigit("１２")).toBe(false);
  });
});

describe("揃える先の幅の印", () => {
  test("本文に出る表記とは別物だと見分けられる", () => {
    expect(isDigitWidthTarget(DIGIT_WIDTH_FULL)).toBe(true);
    expect(isDigitWidthTarget(DIGIT_WIDTH_HALF)).toBe(true);
    // 本文の表記（ほかの組が渡すのはこちら）は印ではない
    expect(isDigitWidthTarget("3")).toBe(false);
    expect(isDigitWidthTarget("３")).toBe(false);
    expect(isDigitWidthTarget("良い")).toBe(false);
  });

  test("全角へ揃えるときは、半角の表記だけに置換先が出る", () => {
    expect(digitWidthReplacement("3", DIGIT_WIDTH_FULL)).toBe("３");
    expect(digitWidthReplacement("0", DIGIT_WIDTH_FULL)).toBe("０");
    // 元から全角なら直すものが無い
    expect(digitWidthReplacement("３", DIGIT_WIDTH_FULL)).toBeUndefined();
    expect(digitWidthReplacement("月", DIGIT_WIDTH_FULL)).toBeUndefined();
  });

  test("半角へ揃えるときは、全角の表記だけに置換先が出る", () => {
    expect(digitWidthReplacement("３", DIGIT_WIDTH_HALF)).toBe("3");
    expect(digitWidthReplacement("0", DIGIT_WIDTH_HALF)).toBeUndefined();
  });
});
