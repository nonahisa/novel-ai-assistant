import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { findAction } from "../../../src/core/actionTree";
import { CONNECT_CLAUDE_CODE } from "../../../src/features/firstRun";

/**
 * 「Claude Code とつなぐ」操作の名前を1つにする（作者の判断 2026-11-01）。
 *
 * メニューは「Claude Code接続」、道案内の段と起動時の声かけのボタンと済んだあとの
 * 案内は「Claude Code とつなぐ」で、作者から見ると画面ごとに違う名前を言っていた。
 * **名前はメニューの項目（`ACTION_TREE` の label）に揃える。** 文の中で動作を言う
 * 「Claude Code とつなぐと〜できます」は名前ではないので、ここでは見ない。
 */
const label = findAction("novelai.connectClaudeCode")?.label ?? "";

describe("Claude Code 接続の名前", () => {
  test("メニューの名前がある（見張りが空回りしていない）", () => {
    expect(label).toBe("Claude Code接続");
  });

  test("起動時の声かけのボタンは、メニューと同じ名前", () => {
    expect(CONNECT_CLAUDE_CODE).toBe(label);
  });

  test("道案内の段の題は、メニューと同じ名前で始まる", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { walkthroughs: Array<{ steps: Array<{ id: string; title: string }> }> };
    };
    const step = pkg.contributes.walkthroughs
      .flatMap((walkthrough) => walkthrough.steps)
      .find((entry) => entry.id === "claudeCode");
    expect(step?.title.startsWith(label)).toBe(true);
    const media = readFileSync("media/walkthrough/claudeCode.md", "utf8");
    expect(media.split(/\r?\n/)[0]).toBe(`# ${step?.title}`);
  });

  test("操作の名前として「Claude Code とつなぐ」を言う案内が残っていない", () => {
    for (const file of [
      "src/features/connectClaudeCode.ts",
      "src/mcp/tools/runRequest.ts",
      "src/features/firstRun.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      // 「」で括って名前として言っている所だけ（コメントの説明は除かない——画面へ出る文と同じ書き方なので）
      const named = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
        .filter((line) => line.includes("「Claude Code とつなぐ」") || line.includes('"Claude Code とつなぐ"'));
      expect(named, file).toEqual([]);
    }
  });
});
