import { afterEach, describe, expect, test, vi } from "vitest";

// 送信量の記録は作品フォルダーへ書くので、ここでは呼ばれたことにして捨てる
vi.mock("../../../src/core/usageLog", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appendUsageLog: () => {},
}));

import { MeteredProvider } from "../../../src/ai/meteredProvider";
import { truncatedOutputAdvice } from "../../../src/ai/outputLimit";
import { SakuraProvider } from "../../../src/ai/sakuraProvider";
import type {
  AIProvider,
  GenerateParams,
  GenerateResult,
  ModelInfo,
} from "../../../src/ai/types";
import { useMemoryTuningStore } from "../support/tuningStore";

/**
 * **関所が出力の上限を縮めた回に、「設定の上限を大きくして」と案内していた**
 * （0.89.6 の担当の報告 #5）。
 *
 * 4,096トークンしか読めないモデル（さくら llm-jp・Phi）では、送る前の関所
 * （`ai/meteredProvider.ts`）が1回の応答の上限を「読める長さ − 入力」まで
 * 縮めて送る（`contextGuard.ts` の `outputTokensWithinWindow`）。その回が
 * 上限で切られると、案内は「設定の『1回の応答の上限』を大きくして」と言って
 * いた——**設定をいくら大きくしても、関所はまた同じ値まで縮める。** 作者を
 * 直らない操作へ導く（`truncatedOutputAdvice` が実測のときに避けた嘘と同じ形）。
 *
 * 縮めたのが関所なら、そう言い、上限を上げても変わらないことを伝える。
 */

/** 4,096しか読めないモデル。応答は `respond` が決める */
function smallModel(
  respond: (params: GenerateParams) => GenerateResult
): AIProvider {
  return {
    id: "sakura",
    displayName: "さくらのAI",
    isPaid: true,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate: async (params) => respond(params),
    getModel: async (id: string): Promise<ModelInfo | undefined> => ({
      id,
      displayName: id,
      contextWindow: 4096,
      parameterSize: null,
      capabilities: [],
      tier: "light",
    }),
  };
}

function request(overrides: Partial<GenerateParams> = {}): GenerateParams {
  return {
    systemPrompt: "あ".repeat(700),
    userPrompt: "い".repeat(700),
    // 同梱の字/トークンが無いモデル名にする（見積りを 0.7 に揃えるため）
    model: "まだ測っていない小さいモデル",
    temperature: 0,
    maxOutputTokens: 11264,
    plannedOutputTokens: 11264,
    ...overrides,
  };
}

describe("関所が縮めた回の切り詰め", () => {
  test("縮めて送った回の応答には、縮めたことが付いて返る", async () => {
    await useMemoryTuningStore({});
    let sent: GenerateParams | undefined;
    const wrapped = new MeteredProvider(
      smallModel((params) => {
        sent = params;
        return { text: '{"issues":[', truncated: true, elapsedMs: 1 };
      })
    );

    const result = await wrapped.generate(request());

    expect(sent?.maxOutputTokens).toBeLessThan(4096);
    expect(result.outputCappedByWindow).toEqual({
      contextWindow: 4096,
      tokens: sent?.maxOutputTokens,
    });
    // プロバイダにも縮めたことが渡る（切られた空の案内を書き分けるため）
    expect(sent?.outputCappedByWindow).toEqual(result.outputCappedByWindow);
  });

  test("案内は「設定の上限を大きくして」と言わず、上げても変わらないと言う（この不具合そのもの）", async () => {
    await useMemoryTuningStore({});
    const wrapped = new MeteredProvider(
      smallModel(() => ({ text: '{"issues":[', truncated: true, elapsedMs: 1 }))
    );
    const result = await wrapped.generate(request());

    const advice = truncatedOutputAdvice(
      { tokens: 11264, source: "設定" },
      result
    );
    expect(advice).not.toContain("大きくしてお試しください");
    expect(advice).toContain("4,096");
    expect(advice).toContain("大きくしても変わりません");
  });

  test("縮めていない回は、これまでどおりの案内（設定を大きくして）", async () => {
    await useMemoryTuningStore({});
    const wrapped = new MeteredProvider(
      smallModel(() => ({ text: '{"issues":[', truncated: true, elapsedMs: 1 }))
    );
    // 出力の見込みが読める長さに届かない（3,000）ので、関所は縮めない
    const result = await wrapped.generate(
      request({ maxOutputTokens: 1500, plannedOutputTokens: 1500 })
    );

    expect(result.outputCappedByWindow).toBeUndefined();
    expect(truncatedOutputAdvice({ tokens: 1500, source: "設定" }, result)).toContain(
      "大きくしてお試しください"
    );
  });
});

describe("さくら：考える途中で縮めた上限を使い切った空", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeContext(): ConstructorParameters<typeof SakuraProvider>[0] {
    return {
      secrets: {
        get: async () => "test-api-key-0123456789",
        store: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as ConstructorParameters<typeof SakuraProvider>[0];
  }

  function stubLengthCut(): void {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: null }, finish_reason: "length" }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
  }

  test("関所が縮めた回なら、「設定の上限を大きくする」を勧めない", async () => {
    stubLengthCut();
    const provider = new SakuraProvider(fakeContext());

    const failure = await provider
      .generate({
        systemPrompt: "指示",
        userPrompt: "本文",
        model: "llm-jp-3.1-8x13b-instruct4",
        temperature: 0,
        maxOutputTokens: 3000,
        outputCappedByWindow: { contextWindow: 4096, tokens: 3000 },
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error
      );

    expect(failure?.message).toContain("上限");
    expect(failure?.message).not.toContain("大きくするか");
    expect(failure?.message).toContain("大きくしても変わりません");
  });

  test("縮めていない回は、これまでどおり上限を大きくするよう勧める", async () => {
    stubLengthCut();
    const provider = new SakuraProvider(fakeContext());

    await expect(
      provider.generate({
        systemPrompt: "指示",
        userPrompt: "本文",
        model: "preview/Qwen3.6-35B-A3B",
        temperature: 0,
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining("大きくするか"),
    });
  });
});
