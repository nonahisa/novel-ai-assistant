import { describe, expect, test } from "vitest";
import {
  LOCAL_MAX_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  parseModelTuning,
  recommendTimeoutFromWorkRate,
  unsuppressedThinkingTokens,
  workRateOf,
} from "../../../src/core/modelTuning";

/**
 * 台帳の新しい欄（仕事に近い形の測定。設計書6.49.9）の読み方と、
 * そこから決まる値。
 */

describe("台帳の新しい欄を読む", () => {
  test("測った欄はそのまま読む。`false` と 固定0秒 も中身として読む", () => {
    const table = parseModelTuning({
      "ollama/gemma4:26b": {
        workSecondsPer1000Chars: 12.5,
        // 長めに倒したとき、固定のぶんはわざと0になる
        workFixedSeconds: 0,
        workMeasuredAt: "2026-09-26T01:00:00.000Z",
        // 考えないモデルだと確かめた——`false` は「測っていない」とは違う
        thinkingSeen: false,
        thinkingMeasuredAt: "2026-09-26T01:00:00.000Z",
      },
      "sakura/preview/Kimi-K2.6": {
        thinkingSeen: true,
        thinkingOffWorks: false,
        thinkingOverheadTokens: 2560,
        contextWindow: 262144,
        contextDeclared: "This model's maximum context length is 262144 tokens",
        contextDeclaredAt: "2026-09-26T01:00:00.000Z",
      },
    });
    expect(table.get("ollama/gemma4:26b")).toEqual({
      workSecondsPer1000Chars: 12.5,
      workFixedSeconds: 0,
      workMeasuredAt: "2026-09-26T01:00:00.000Z",
      thinkingSeen: false,
      thinkingMeasuredAt: "2026-09-26T01:00:00.000Z",
    });
    const kimi = table.get("sakura/preview/Kimi-K2.6");
    expect(kimi?.thinkingOffWorks).toBe(false);
    expect(kimi?.thinkingOverheadTokens).toBe(2560);
    expect(kimi?.contextDeclared).toContain("262144");
  });

  test("壊れた欄はその欄だけ捨て、ほかは読む", () => {
    const table = parseModelTuning({
      "ollama/x": {
        workSecondsPer1000Chars: "12",
        workFixedSeconds: -1,
        thinkingOffWorks: "false",
        thinkingOverheadTokens: 0,
        timeoutSeconds: 300,
      },
    });
    expect(table.get("ollama/x")).toEqual({ timeoutSeconds: 300 });
  });
});

describe("1000字あたりの秒数から、待ち時間を見立てる", () => {
  test("20,000字を1回送る見込みに1.5倍を掛け、30秒刻みに切り上げる", () => {
    // 5 + 10 × 20 = 205秒 → ×1.5 = 307.5 → 330秒
    expect(
      recommendTimeoutFromWorkRate({ fixedSeconds: 5, secondsPer1000Chars: 10 })
    ).toBe(330);
  });

  test("速いモデルでも、いまの既定（180秒）を下回らせない", () => {
    expect(
      recommendTimeoutFromWorkRate({ fixedSeconds: 1, secondsPer1000Chars: 0.5 })
    ).toBe(MIN_TIMEOUT_SECONDS);
  });

  test("上限はプロバイダごと（クラウド600秒・手元1800秒）", () => {
    const slow = { fixedSeconds: 30, secondsPer1000Chars: 40 };
    // 30 + 800 = 830 → ×1.5 = 1,245 → 1,260
    expect(recommendTimeoutFromWorkRate(slow)).toBe(MAX_TIMEOUT_SECONDS);
    expect(recommendTimeoutFromWorkRate(slow, LOCAL_MAX_TIMEOUT_SECONDS)).toBe(1260);
  });

  test("台帳の行から見込みの式を引く。測っていなければ無い", () => {
    expect(workRateOf({ workSecondsPer1000Chars: 3, workFixedSeconds: 2 })).toEqual({
      fixedSeconds: 2,
      secondsPer1000Chars: 3,
    });
    // 固定のぶんが欠けていても、1000字あたりがあれば使う（固定は0とみなす）
    expect(workRateOf({ workSecondsPer1000Chars: 3 })).toEqual({
      fixedSeconds: 0,
      secondsPer1000Chars: 3,
    });
    expect(workRateOf({ timeoutSeconds: 300 })).toBeUndefined();
    expect(workRateOf(undefined)).toBeUndefined();
  });
});

describe("止められない思考のぶん", () => {
  test("効かないと確かめたモデルだけ足す", () => {
    expect(
      unsuppressedThinkingTokens({ thinkingOffWorks: false, thinkingOverheadTokens: 2560 })
    ).toBe(2560);
    // 効く・考えない・まだ見分けていないモデルは0（これまでどおり）
    expect(
      unsuppressedThinkingTokens({ thinkingOffWorks: true, thinkingOverheadTokens: 2560 })
    ).toBe(0);
    expect(unsuppressedThinkingTokens({ thinkingSeen: false })).toBe(0);
    expect(unsuppressedThinkingTokens(undefined)).toBe(0);
  });
});
