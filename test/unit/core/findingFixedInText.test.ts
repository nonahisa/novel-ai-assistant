import { describe, expect, test } from "vitest";
import {
  canCheckFixedInText,
  isFixedInText,
} from "../../../src/core/findingFixedInText";

/**
 * 作者が本文で直したかの照らし（作者の知らせ 2026-11-27。設計書6.96.5）。
 *
 * **外してよいのは、原文が本文のどこにも無いときだけ。** 行がずれただけで
 * 外すと、上に1行足すたびに下の指摘が全部消える。
 */

const row = {
  line: 2,
  original: "　夜が開けた。",
  target: "開けた",
  suggestion: "明けた",
};

describe("isFixedInText", () => {
  test("その行の原文が直されていれば、直されたとみなす", () => {
    expect(isFixedInText("　朝。\n　夜が明けた。\n", row)).toBe(true);
  });

  test("原文がその行にそのまま在れば、直されていない", () => {
    expect(isFixedInText("　朝。\n　夜が開けた。\n", row)).toBe(false);
  });

  test("行がずれただけ（原文は別の行に在る）なら、直されていない", () => {
    expect(isFixedInText("　前置き。\n　朝。\n　夜が開けた。\n", row)).toBe(false);
  });

  test("行が消えて本文が短くなっても、原文が残っていれば直されていない", () => {
    expect(isFixedInText("　夜が開けた。\n", row)).toBe(false);
  });

  test("原文の無い指摘は、直されたことにしない", () => {
    expect(isFixedInText("　朝。\n", { ...row, original: "" })).toBe(false);
  });

  test("空白だけの原文も、直されたことにしない（探し直しが空白を除いて比べるため）", () => {
    expect(isFixedInText("　朝。\n", { ...row, original: "　　", target: "　" })).toBe(false);
  });

  test("空白だけを直したときは、直されたとみなさない（探し直しが空白を除いて比べる。既知の限り）", () => {
    const spaced = { line: 1, original: "彼は  走った。", target: "  ", suggestion: "" };
    expect(isFixedInText("彼は走った。\n", spaced)).toBe(false);
  });
});

describe("canCheckFixedInText", () => {
  test("ふつうの本文は照らしてよい", () => {
    expect(canCheckFixedInText("　朝。\n")).toBe(true);
  });

  test("空・空白だけの本文（保存の途中）は照らさない", () => {
    expect(canCheckFixedInText("")).toBe(false);
    expect(canCheckFixedInText("\n\n")).toBe(false);
  });

  test("競合マーカーを含む本文は照らさない", () => {
    expect(canCheckFixedInText("<<<<<<< HEAD\n　朝。\n=======\n　昼。\n>>>>>>> b\n")).toBe(false);
  });
});

/**
 * 区切った行を渡しても判断は同じ（動作の高速化、2026-11-27）。提案パネルは
 * ファイルごとに1回だけ区切って、同じ行の配列で何件も照らす。
 * 物差しは2つの重ね（［当てる］の `originalMissing` と、探し直しの `lost`）のまま。
 */
describe("isFixedInText に区切った行を渡す", () => {
  const body = "　朝。\n　夜が開けた。\n　彼は走つた。\n\n　夜が開けた。\n　終わり。";
  const rows = [
    { line: 2, original: "　夜が開けた。", target: "開けた", suggestion: "明けた" },
    { line: 1, original: "　夜が開けた。", target: "開けた", suggestion: "明けた" },
    { line: 3, original: "　彼は走つた。", target: "走つた", suggestion: "走った" },
    { line: 3, original: "　消えた原文。", target: "消えた", suggestion: "残った" },
    { line: 99, original: "　夜が開けた。", target: "開けた", suggestion: "明けた" },
    { line: 99, original: "　どこにも無い。", target: "無い", suggestion: "在る" },
    { line: 4, original: "", target: "", suggestion: "x" },
    { line: 4, original: "　 ", target: " ", suggestion: "x" },
    { line: 3, original: "走つ", target: "無い語", suggestion: "x" },
  ];

  test("1件ごとに区切ったときと、同じ判断になる", () => {
    const lines = body.split("\n");
    for (const r of rows) {
      expect(isFixedInText(body, r, lines), JSON.stringify(r)).toBe(isFixedInText(body, r));
    }
    // 判断そのもの（どれが「直された」か）も押さえる
    expect(rows.map((r) => isFixedInText(body, r, lines))).toEqual([
      false, false, false, true, false, true, false, false, false,
    ]);
  });

  test("渡した行の配列を書き換えない（次の指摘にも同じ配列を使う）", () => {
    const lines = body.split("\n");
    const copy = [...lines];
    for (const r of rows) isFixedInText(body, r, lines);
    expect(lines).toEqual(copy);
  });
});
