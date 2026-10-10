import { describe, expect, test } from "vitest";
import {
  DEVIATION_CHECK_VERSION,
  DEVIATION_TYPES,
  LIGHT_DEVIATION_TYPES,
  buildDeviationCheckPrompt,
  type DeviationType,
} from "../../../src/prompts/deviationCheck";

/**
 * P-11 1.3（作者の裁定 2026-10-10 朝、A15）。1.2 で足した「指摘が無いときは空の配列で
 * 返し、そこで終える」を、**食い違いが本当に1つも無いときだけ**に条件づけた。
 * 26b は 1.2 の文で5回とも空の配列を返し、第2話の逸脱を見逃した（1.1 の文では5回とも
 * 拾った。`docs/measurements/2026-10-10-deviation-*`）。一文を消さないのは、さくらの 31b で
 * 空白が出力上限まで続いた暴走（01277e11）を防ぐため。
 */
function prompt(types: readonly DeviationType[]): string {
  return buildDeviationCheckPrompt({
    chapterLabel: "第2話",
    plot: "主人公は街を出る。",
    chapterTextWithLineNumbers: "1: 主人公は街に残った。",
    surroundingSynopses: "",
    types,
    maxIssues: 3,
  });
}

describe("P-11 1.3：空の配列は、食い違いが本当に1つも無いときだけ", () => {
  test("版は 1.3", () => {
    expect(DEVIATION_CHECK_VERSION).toBe("1.3");
  });

  test("大きいモデル向け（逸脱と間延び）：両方とも無いときだけ空の配列", () => {
    const text = prompt(DEVIATION_TYPES);
    expect(text).toContain(
      "プロットとの食い違いも間延びも本当に1つも無いときだけ、" +
        '"deviations" を空の配列にして、そこで出力を終えてください。'
    );
    expect(text).toContain("食い違いがあるときは、挙げてください。");
  });

  test("小さいモデル向け（逸脱だけ）：新しい一文に間延びを入れない（プロンプト設計書1.3）", () => {
    const text = prompt(LIGHT_DEVIATION_TYPES);
    expect(text).toContain(
      "プロットとの食い違いが本当に1つも無いときだけ、" +
        '"deviations" を空の配列にして、そこで出力を終えてください。'
    );
    expect(text).toContain("食い違いがあるときは、挙げてください。");
    // 【判断の注意】の「間延びと判断しないこと」はもとから両方に入っているので、
    // 見るのは新しい一文だけ
    expect(text).not.toContain("間延びも本当に");
  });

  test("1.2 の言い切り（指摘が無いときは…終える）は残さない", () => {
    for (const types of [DEVIATION_TYPES, LIGHT_DEVIATION_TYPES]) {
      expect(prompt(types)).not.toContain(
        '指摘が無いときは "deviations" を空の配列にして'
      );
    }
  });

  test("暴走を防ぐ2つの文（該当なしの要素・閉じ括弧のあと）は残る", () => {
    for (const types of [DEVIATION_TYPES, LIGHT_DEVIATION_TYPES]) {
      const text = prompt(types);
      expect(text).toContain("「該当なし」を表す要素を入れないこと。");
      expect(text).toContain("閉じ括弧のあとに空白や改行を続けないこと。");
    }
  });
});
