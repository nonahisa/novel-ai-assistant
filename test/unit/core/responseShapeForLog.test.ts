import { describe, expect, test } from "vitest";
import { responseShapeForLog } from "../../../src/core/logger";

describe("読み取れなかった応答の形をログへ1行で残す", () => {
  test("形がずれた答えは、最上位の鍵で分かる", () => {
    // 2026-10-10 の冒頭診断：elements ではなく five_w1h で返った
    const text = JSON.stringify({ five_w1h: { when: { conveyed: false } }, hook: {} });
    expect(responseShapeForLog(text)).toBe(`${text.length}字／最上位の鍵: five_w1h, hook`);
  });

  test("途中で切れた答えは、JSONとして読めないと書く", () => {
    expect(responseShapeForLog('{"elements":[{"note":"あ"}')).toContain("途中で切れた可能性");
  });

  test("JSONでない答えは、括弧が無いと書く", () => {
    expect(responseShapeForLog("申し訳ありません")).toBe("8字／JSONの括弧が見当たらない");
  });
});
