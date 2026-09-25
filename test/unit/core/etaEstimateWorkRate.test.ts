import { describe, expect, test } from "vitest";
import {
  describeCallTimeEstimate,
  estimateCallsTimeFromWorkRate,
  mergeCallTimeEstimates,
} from "../../../src/core/etaEstimate";

/**
 * AIチューニングの「1000字あたり何秒」からの見込み（設計書6.49.9）。
 *
 * **名乗りを取り違えない**——この速さは誤字脱字と同じ形の短い文で測った
 * ものなので、「これまでの実測から」とも「決め打ち」とも言わない。
 */
describe("1000字あたりの秒数からの見込み", () => {
  const rate = { fixedSeconds: 5, secondsPer1000Chars: 10 };

  test("回ごとに「固定＋1000字あたり×字数」を足す", () => {
    const estimate = estimateCallsTimeFromWorkRate([1000, 3000], rate);
    // (5 + 10) + (5 + 30) = 50秒
    expect(estimate).toEqual({ ms: 50_000, source: "tuning" });
  });

  test("字数が1件も無ければ作らない", () => {
    expect(estimateCallsTimeFromWorkRate([], rate)).toBeUndefined();
  });

  test("確認画面では、AIチューニングの測定から、と名乗る", () => {
    const text = describeCallTimeEstimate({ ms: 120_000, source: "tuning" });
    expect(text).toContain("目安 2 分程度");
    expect(text).toContain("AIチューニング");
    expect(text).not.toContain("決め打ち");
  });

  test("実測と混ぜても「決め打ち」とは言わない（弱いほうの名乗りにする）", () => {
    const merged = mergeCallTimeEstimates([
      { ms: 60_000, source: "measured" },
      { ms: 120_000, source: "tuning" },
    ]);
    expect(merged).toEqual({ ms: 90_000, source: "tuning" });
  });

  test("決め打ちが混ざれば、これまでどおり決め打ちが混ざったと言う", () => {
    const merged = mergeCallTimeEstimates([
      { ms: 60_000, source: "tuning" },
      { ms: 120_000, source: "fixed", unmeasured: "both" },
    ]);
    expect(merged?.source).toBe("partial");
    expect(merged?.unmeasured).toBe("both");
  });
});
