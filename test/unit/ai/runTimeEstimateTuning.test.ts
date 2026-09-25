import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryTuningStore } from "../support/tuningStore";
import {
  estimateCallsTimeFor,
  estimateRunTimeText,
  lookupCallSpeeds,
} from "../../../src/ai/runTimeEstimate";
import { featureOutputKey } from "../../../src/core/featureOutputTokens";
import { modelTuningKey } from "../../../src/core/modelTuning";

/**
 * **押す前の見込みに、AIチューニングの「1000字あたり何秒」を使う**
 * （設計書6.49.9。作者の判断、2026-09-26）。
 *
 * 普段の量（平均）がまだ無いモデルでは、これまで「見当が付きません」か、
 * 同梱の最大・決め打ちの秒数から見積もっていた。仕事に近い形で測って
 * あれば、この機械でこのモデルに実際に書かせた時間のほうが当たる。
 *
 * **平均が貯まれば平均が勝つ**——その機能の、この機械での普段の量なので。
 */

const PROVIDER = "ollama";
const MODEL = "gemma4:26b";
/** 1回ごとに5秒＋本文1000字あたり10秒 */
const RATE = { workFixedSeconds: 5, workSecondsPer1000Chars: 10 };

beforeEach(async () => {
  await useMemoryTuningStore({});
});

describe("確認画面の見込み（検知）", () => {
  it("普段の量が無ければ、1000字あたりの秒数から見積もり、そう名乗る", async () => {
    await useMemoryTuningStore({ [modelTuningKey(PROVIDER, MODEL)]: RATE });
    // 3回 ×（5 + 10 × 6）= 195秒 → およそ3分
    const text = estimateRunTimeText({
      providerId: PROVIDER,
      model: MODEL,
      feature: "typo_check",
      count: 3,
      inputChars: [6000, 6000, 6000],
    });
    expect(text).toContain("およそ3分");
    expect(text).toContain("AIチューニング");
    expect(text).toContain("1000字あたり");
    // 同梱の最大から「多めに」とは言わない
    expect(text).not.toContain("同梱");
  });

  it("普段の量（平均）があれば、そちらが勝つ", async () => {
    await useMemoryTuningStore({
      [modelTuningKey(PROVIDER, MODEL)]: { ...RATE, outputTokensPerSecond: 100 },
      [featureOutputKey("typo_check", PROVIDER, MODEL)]: {
        outputTokens: 9000,
        outputTokensAverage: 3000,
        outputTokenSamples: 5,
      },
    });
    const text = estimateRunTimeText({
      providerId: PROVIDER,
      model: MODEL,
      feature: "typo_check",
      count: 10,
      inputChars: new Array<number>(10).fill(6000),
    });
    expect(text).toContain("これまでの実測から");
    expect(text).not.toContain("AIチューニング");
  });

  it("字数を渡さない呼び出しは、これまでどおり（1000字あたりは使えない）", async () => {
    await useMemoryTuningStore({ [modelTuningKey(PROVIDER, MODEL)]: RATE });
    const text = estimateRunTimeText({
      providerId: PROVIDER,
      model: MODEL,
      feature: "typo_check",
      count: 3,
    });
    expect(text).not.toContain("AIチューニング");
    // 字数が無いと1000字あたりからは作れない。当てずっぽうを書かない
    expect(text).toContain("見当が付きません");
  });
});

describe("確認画面の目安（抽出など）", () => {
  it("書く側が測れていなければ、決め打ちより先に1000字あたりを使う", async () => {
    await useMemoryTuningStore({ [modelTuningKey(PROVIDER, MODEL)]: RATE });
    const estimate = estimateCallsTimeFor({
      providerId: PROVIDER,
      model: MODEL,
      feature: "character_extract",
      inputChars: [2000, 2000],
      fallbackSecondsPerCall: 20,
    });
    expect(estimate?.source).toBe("tuning");
    // 2回 ×（5 + 10 × 2）= 50秒
    expect(estimate?.ms).toBe(50_000);
  });

  it("測っていなければ、これまでどおり決め打ちへ落ちる", () => {
    const estimate = estimateCallsTimeFor({
      providerId: PROVIDER,
      model: "まだ測っていないモデル",
      feature: "character_extract",
      inputChars: [2000, 2000],
      fallbackSecondsPerCall: 20,
    });
    expect(estimate?.source).toBe("fixed");
  });
});

describe("止められない思考のぶんを、同梱の最大に足す", () => {
  it("同梱の最大には足し、このモデル自身の実測には足さない", async () => {
    await useMemoryTuningStore({
      [modelTuningKey("sakura", "preview/Kimi-K2.6")]: {
        thinkingOffWorks: false,
        thinkingOverheadTokens: 2560,
      },
    });
    // 同梱の typo_check の最大は 8,753
    expect(
      lookupCallSpeeds("sakura", "preview/Kimi-K2.6", "typo_check").outputTokensPerCall
    ).toBe(8753 + 2560);

    await useMemoryTuningStore({
      [modelTuningKey("sakura", "preview/Kimi-K2.6")]: {
        thinkingOffWorks: false,
        thinkingOverheadTokens: 2560,
      },
      [featureOutputKey("typo_check", "sakura", "preview/Kimi-K2.6")]: {
        outputTokens: 4000,
        outputTokenSamples: 3,
      },
    });
    expect(
      lookupCallSpeeds("sakura", "preview/Kimi-K2.6", "typo_check").outputTokensPerCall
    ).toBe(4000);
  });
});
