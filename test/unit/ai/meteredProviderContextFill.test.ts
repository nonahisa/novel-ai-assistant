import { beforeEach, describe, expect, test } from "vitest";
import { tuningStoreContents, useMemoryTuningStore } from "../support/tuningStore";
import { MeteredProvider } from "../../../src/ai/meteredProvider";
import { truncatedOutputAdvice } from "../../../src/ai/outputLimit";
import { resetAiSequence } from "../../../src/core/aiSequence";
import { featureOutputKey } from "../../../src/core/featureOutputTokens";
import type {
  AIProvider,
  GenerateParams,
  GenerateResult,
} from "../../../src/ai/types";

/**
 * **見積もりでは入ると判断して縮めずに送ったのに、実際の数が読める長さに
 * 届いて切れた回**（作者の決定 2026-11-23「途中で切れたと見分けて、次の操作を示す」）。
 *
 * 実機の例：llama.cpp の server・gemma4:26b・文脈 8192、設定資料の抽出で
 * 入力 6,685＋出力 1,507＝8,192 トークンで finish_reason=length。
 * このとき「1回の応答の上限を大きく」と案内しても直らない——上限を上げても、
 * 読める長さは同じだけしかない。
 */

const PROVIDER = "lmstudio";
const MODEL = "gemma4:26b";
const WINDOW = 8_192;

function fakeProvider(
  result: () => GenerateResult,
  // 読める長さが分からない回は null で渡す（undefined だと既定の値に化ける）
  contextWindow: number | null = WINDOW
): AIProvider {
  return {
    id: PROVIDER,
    displayName: "手元のAI",
    isPaid: false,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    getModel: async (id) =>
      contextWindow === null
        ? undefined
        : {
            id,
            displayName: id,
            contextWindow,
            parameterSize: null,
            capabilities: [],
            tier: "standard",
          },
    generate: async () => result(),
  };
}

/**
 * 見積もりでは入る頼み。**出力の上限を小さく明示する**——渡さないと
 * 設定値（16,384）が見込みになり、関所が縮める道（`outputCappedByWindow`）に
 * 入ってしまって、この回を再現できない。
 */
function params(feature = "settings_extract"): GenerateParams {
  return {
    systemPrompt: "あ".repeat(500),
    userPrompt: "い".repeat(3_000),
    model: MODEL,
    temperature: 0,
    maxOutputTokens: 1_600,
    plannedOutputTokens: 1_600,
    meta: { feature },
  };
}

function cut(inputTokens: number, outputTokens: number): GenerateResult {
  return {
    text: "{\"items\": [",
    truncated: true,
    elapsedMs: 500,
    usage: { inputTokens, outputTokens },
  };
}

beforeEach(async () => {
  await useMemoryTuningStore({});
  resetAiSequence();
});

describe("読める長さに届いて切れた回を見分ける", () => {
  test("入力＋出力が読める長さちょうどなら、印を付けて返す", async () => {
    const metered = new MeteredProvider(fakeProvider(() => cut(6_685, 1_507)));

    const result = await metered.generate(params());

    // 関所は縮めていない（見積もりでは入った）
    expect(result.outputCappedByWindow).toBeUndefined();
    expect(result.filledContextWindow).toEqual({
      contextWindow: WINDOW,
      usedTokens: 8_192,
    });
  });

  test("その回の案内は、上限ではなく読める長さの一手を示す", async () => {
    const metered = new MeteredProvider(fakeProvider(() => cut(6_685, 1_507)));

    const result = await metered.generate(params());
    const advice = truncatedOutputAdvice({ tokens: 16_384, source: "設定" }, result);

    expect(advice).toContain("読める長さ");
    expect(advice).not.toContain("「1回の応答の上限」を大きく");
  });

  test("読める長さに届いていない切れ方は、今の案内のまま", async () => {
    const metered = new MeteredProvider(fakeProvider(() => cut(3_000, 1_600)));

    const result = await metered.generate(params());

    expect(result.filledContextWindow).toBeUndefined();
    expect(
      truncatedOutputAdvice({ tokens: 16_384, source: "設定" }, result)
    ).toContain("「1回の応答の上限」を大きく");
  });

  test("読める長さが分からなければ、印を付けない", async () => {
    const metered = new MeteredProvider(
      fakeProvider(() => cut(6_685, 1_507), null)
    );

    const result = await metered.generate(params());

    expect(result.filledContextWindow).toBeUndefined();
  });

  test("数が返らなければ、印を付けない（エラー文から当てない）", async () => {
    const metered = new MeteredProvider(
      fakeProvider(() => ({ text: "{", truncated: true, elapsedMs: 500 }))
    );

    const result = await metered.generate(params());

    expect(result.filledContextWindow).toBeUndefined();
  });

  test("切れていない回には、数が届いていても印を付けない", async () => {
    const metered = new MeteredProvider(
      fakeProvider(() => ({ ...cut(6_685, 1_507), truncated: false, text: "{}" }))
    );

    const result = await metered.generate(params());

    expect(result.filledContextWindow).toBeUndefined();
  });

  test("その回を「出力の上限が足りなかった」と台帳に数えない", async () => {
    // 数えると、以後その機能は見込みを失って設定値の上限で送る——
    // 読める長さは変わらないので、直らない学習になる
    const metered = new MeteredProvider(fakeProvider(() => cut(6_685, 1_507)));

    await metered.generate(params("settings_extract"));

    const row = tuningStoreContents()[
      featureOutputKey("settings_extract", PROVIDER, MODEL)
    ] as Record<string, unknown> | undefined;
    expect(row?.outputTruncated).toBeUndefined();
    expect(row?.outputTokens).toBeUndefined();
  });

  test("読める長さに届かない切れ方は、これまでどおり印として残す", async () => {
    const metered = new MeteredProvider(fakeProvider(() => cut(3_000, 1_600)));

    await metered.generate(params("settings_extract"));

    const row = tuningStoreContents()[
      featureOutputKey("settings_extract", PROVIDER, MODEL)
    ] as Record<string, unknown> | undefined;
    expect(row?.outputTruncated).toBe(true);
  });
});
