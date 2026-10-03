import { describe, expect, it } from "vitest";
import { applyFindingToText } from "../../../src/core/findingApply";

/**
 * 指摘1件を本文へ当てる計算（提案パネルの［適用］と MCP の取り込み 6.115 が共用）。
 * 切り出す前の `applyIssue` と同じ結果になることを見る。
 */
describe("applyFindingToText", () => {
  it("その行の原文の中の直す語だけを置き換え、入れた位置を返す", () => {
    const result = applyFindingToText("一行目\n「わらった」と彼はわらった。\n", {
      line: 2,
      original: "彼はわらった。",
      target: "わらった",
      suggestion: "笑った",
    });
    // 同じ行の前にある「わらった」（会話の中）は直さない
    expect(result).toEqual({
      kind: "applied",
      text: "一行目\n「わらった」と彼は笑った。\n",
      at: 9,
    });
  });

  it("その行に原文が無ければ当てない", () => {
    expect(
      applyFindingToText("一行目\n二行目\n", {
        line: 2,
        original: "彼はわらった。",
        target: "わらった",
        suggestion: "笑った",
      })
    ).toEqual({ kind: "originalMissing" });
    expect(
      applyFindingToText("一行目\n", {
        line: 5,
        original: "一行目",
        target: "一",
        suggestion: "1",
      })
    ).toEqual({ kind: "originalMissing" });
  });

  it("原文の中に直す語が無ければ当てない", () => {
    expect(
      applyFindingToText("彼はわらった。\n", {
        line: 1,
        original: "彼はわらった。",
        target: "ないた",
        suggestion: "泣いた",
      })
    ).toEqual({ kind: "targetMissing" });
  });
});
