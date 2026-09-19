import { beforeEach, describe, expect, test } from "vitest";
import { tuningStoreContents, useMemoryTuningStore } from "./support/tuningStore";
import { MeteredProvider } from "../../src/ai/meteredProvider";
import { resetAiSequence } from "../../src/core/aiSequence";
import {
  MIN_FEATURE_OUTPUT_SAMPLES,
  featureOutputKey,
} from "../../src/core/featureOutputTokens";
import { CONTEXT_GUARD_EXEMPT_FEATURE } from "../../src/ai/contextGuard";
import type {
  AIProvider,
  GenerateParams,
  GenerateResult,
} from "../../src/ai/types";

/**
 * **実測を記録する道**（設計書6.77の第3段）。
 *
 * 出力に見込むトークン数を実測から決めるには、まず実測が貯まらなければ
 * ならない。`usage.completion_tokens` は毎回返ってきており、`usage.md` へは
 * 書いていたが、**次の見込みには使っていなかった。**
 *
 * 採る場所は関所（`MeteredProvider`）の1か所である。速さ・字/トークンと
 * まったく同じ理由で、**全プロバイダ・全機能がここを通る**——機能側に
 * 書くと、新しい機能を足した人が書き忘れる。
 */

function fakeProvider(result: () => GenerateResult): AIProvider {
  return {
    id: "sakura",
    displayName: "さくらのAI",
    isPaid: true,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate: async () => result(),
  };
}

function params(feature: string): GenerateParams {
  return {
    systemPrompt: "あ".repeat(100),
    userPrompt: "い".repeat(1_000),
    model: "gpt-oss-120b",
    temperature: 0,
    meta: { feature },
  };
}

function reply(outputTokens: number, truncated = false): GenerateResult {
  return {
    text: "{}",
    truncated,
    elapsedMs: 500,
    usage: { inputTokens: 1_000, outputTokens },
  };
}

/** その機能の行（無ければ空） */
function entryOf(feature: string): Record<string, unknown> {
  const row = tuningStoreContents()[featureOutputKey(feature)];
  return typeof row === "object" && row !== null
    ? (row as Record<string, unknown>)
    : {};
}

beforeEach(async () => {
  await useMemoryTuningStore({});
  resetAiSequence();
});

describe("普段の呼び出しから、機能ごとの出力トークン数を採る", () => {
  test("応答の `completion_tokens` を、機能の行へ覚える", async () => {
    const metered = new MeteredProvider(fakeProvider(() => reply(9_100)));

    await metered.generate(params("typo_check"));

    expect(entryOf("typo_check").outputTokens).toBe(9_100);
    expect(entryOf("typo_check").outputTokenSamples).toBe(1);
  });

  test("覚えるのは最大値（小さい回で上書きしない）", async () => {
    // 字/トークンは最小値を覚えるが、こちらは逆である。**小さく見ると
    // 応答が切れて、そのチャンクが丸ごと捨てられる**
    const metered = new MeteredProvider(fakeProvider(() => reply(9_100)));
    await metered.generate(params("typo_check"));

    const small = new MeteredProvider(fakeProvider(() => reply(2_000)));
    await small.generate(params("typo_check"));

    expect(entryOf("typo_check").outputTokens).toBe(9_100);
    expect(entryOf("typo_check").outputTokenSamples).toBe(2);
  });

  test("切り詰められた回は、量ではなく印として残す", async () => {
    // 切られた回の `completion_tokens` は上限そのもので、要った量ではない
    const metered = new MeteredProvider(fakeProvider(() => reply(16_384, true)));

    await metered.generate(params("blurb"));

    expect(entryOf("blurb").outputTokens).toBeUndefined();
    expect(entryOf("blurb").outputTruncated).toBe(true);
  });

  test("読める長さの測定からは採らない（わざと上限を試す呼び出し）", async () => {
    const metered = new MeteredProvider(fakeProvider(() => reply(9_100)));

    await metered.generate(params(CONTEXT_GUARD_EXEMPT_FEATURE));

    expect(entryOf(CONTEXT_GUARD_EXEMPT_FEATURE).outputTokens).toBeUndefined();
  });

  test("しきい値に届いたあとは、最大値が上がった回しか書かない", async () => {
    const metered = new MeteredProvider(fakeProvider(() => reply(9_100)));
    for (let i = 0; i < MIN_FEATURE_OUTPUT_SAMPLES + 5; i += 1) {
      await metered.generate(params("typo_check"));
    }

    // 呼び出しの回数ではなく、**台帳へ書いた回数**が入る（少なめに出る
    // ぶんには、信じ始めるのが遅れるだけで安全側）
    expect(entryOf("typo_check").outputTokenSamples).toBe(
      MIN_FEATURE_OUTPUT_SAMPLES
    );
  });

  test("出力トークン数を返さないAIからは採らない（字数で見積もらない）", async () => {
    const metered = new MeteredProvider(
      fakeProvider(() => ({ text: "{}", truncated: false, elapsedMs: 500 }))
    );

    await metered.generate(params("typo_check"));

    expect(entryOf("typo_check").outputTokens).toBeUndefined();
  });
});
