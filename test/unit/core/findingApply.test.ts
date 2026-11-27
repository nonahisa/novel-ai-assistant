import { describe, expect, it } from "vitest";
import {
  applyFindingToText,
  carryFindingOverEdit,
} from "../../../src/core/findingApply";

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

/**
 * 同じ行の別の指摘を当てたあと、この指摘の原文を写し直す計算（設計書6.96.5）。
 * 書き換えた位置から決め、探し直さない。
 */
describe("carryFindingOverEdit", () => {
  const line = "　彼は走つて家え帰った。";
  const b = { original: "　彼は走つて家え帰った。", target: "家え" };
  // A：走つて→走って（列3）
  const editA = { at: 3, removed: "走つて", inserted: "走って" };

  it("書き換えが原文の中で直す語に重ならなければ写し、写した原文で当たる", () => {
    const carried = carryFindingOverEdit(line, editA, b);
    expect(carried).toEqual({ kind: "carried", original: "　彼は走って家え帰った。" });
    if (carried.kind !== "carried") return;
    expect(
      applyFindingToText("　彼は走って家え帰った。", {
        line: 1,
        original: carried.original,
        target: b.target,
        suggestion: "家へ",
      })
    ).toEqual({ kind: "applied", text: "　彼は走って家へ帰った。", at: 6 });
  });

  it("字数の変わる書き換えが直す語より前にあっても、写した原文で直す語が見つかる", () => {
    expect(
      carryFindingOverEdit(line, { at: 3, removed: "走つて", inserted: "駆けだして" }, b)
    ).toEqual({ kind: "carried", original: "　彼は駆けだして家え帰った。" });
    expect(
      carryFindingOverEdit(line, { at: 3, removed: "走つて", inserted: "走り" }, b)
    ).toEqual({ kind: "carried", original: "　彼は走り家え帰った。" });
  });

  it("直す語そのものが書き換わったら写さない", () => {
    expect(
      carryFindingOverEdit(
        line,
        { at: 6, removed: "家え帰", inserted: "家へ帰" },
        { original: b.original, target: "え帰" }
      )
    ).toEqual({ kind: "broken" });
  });

  it("書き換えが原文の端をまたぐなら写さない", () => {
    expect(
      carryFindingOverEdit(
        "前置き。彼は走つた。",
        { at: 2, removed: "き。彼", inserted: "き、彼" },
        { original: "彼は走つた。", target: "走つた" }
      )
    ).toEqual({ kind: "broken" });
  });

  it("書き換えが原文の外なら、そのまま（untouched）", () => {
    expect(
      carryFindingOverEdit(
        "夜が開けた。彼は走つた。",
        { at: 2, removed: "開け", inserted: "明け" },
        { original: "彼は走つた。", target: "走つた" }
      )
    ).toEqual({ kind: "untouched" });
  });

  it("書き換えで前に同じ句ができ、当たる所が変わるなら写さない", () => {
    expect(
      carryFindingOverEdit(
        "Ｘ。彼は走つた。",
        { at: 0, removed: "Ｘ", inserted: "彼は走つた" },
        { original: "彼は走つた。", target: "走つた" }
      )
    ).toEqual({ kind: "broken" });
  });

  it("書き換える前から当たらない指摘には触らない", () => {
    expect(
      carryFindingOverEdit(line, editA, { original: "無い文。", target: "無い" })
    ).toEqual({ kind: "untouched" });
  });
});
