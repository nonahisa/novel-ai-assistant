import * as fs from "fs";
import * as path from "path";
import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", () => ({
  window: { showWarningMessage: vi.fn() },
}));
vi.mock("../../src/core/logger", () => ({ logFailure: vi.fn() }));

import { describeAIError } from "../../src/features/reportAIError";
import { AIError } from "../../src/ai/types";

/**
 * AIの失敗の伝え方（設計書6.44）。
 *
 * 同じ関数が4ファイルに写っていたのを1つへ集めた（0.28.4）。
 */
describe("AIの失敗の本文", () => {
  test("AIError なら、何が起きたかと次にできることを並べる", () => {
    const text = describeAIError(
      new AIError("残高が不足しています。", "insufficient_credit")
    );
    expect(text).toContain("残高が不足しています。");
    // 種別ごとの復旧案内が付く（CLAUDE.md 規則5）
    expect(text).toContain("クレジット");
  });

  test("ただのエラーは、その文言をそのまま使う", () => {
    expect(describeAIError(new Error("壊れました"))).toBe("壊れました");
  });

  test("文字列や未知の値も捨てない", () => {
    expect(describeAIError("何かが起きた")).toBe("何かが起きた");
    expect(describeAIError(undefined)).toBe("undefined");
  });
});

describe("写しを作らない", () => {
  test("features に reportAIError の定義は1つだけ", () => {
    // **5つ目を作らせない。** 4ファイルに1文字も違わない写しがあり、
    // 直すときに片方だけ直る形だった
    const dir = path.join(__dirname, "..", "..", "src", "features");
    const defining = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) =>
        /function reportAIError\s*\(/.test(fs.readFileSync(path.join(dir, name), "utf8"))
      );
    expect(defining).toEqual(["reportAIError.ts"]);
  });
});
