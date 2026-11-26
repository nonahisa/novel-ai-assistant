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
