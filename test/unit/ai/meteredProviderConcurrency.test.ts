import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 関所（`MeteredProvider`）を通したときに、同時に飛ぶ数（設計書6.76.3）。
 *
 * 機能の輪を3本にしても、関所が1本のままなら速くならない。**作り物のAIを
 * `MeteredProvider` で包んで**確かめる——素のままだと、関所が1本でも通ってしまう。
 *
 * - クラウドは3本まで同時に飛ぶ（4本目以降は待つ）
 * - 手元のAI（Ollama・LM Studio）は1本ずつのまま
 */

vi.mock("../../../src/core/usageLog", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/core/usageLog")>();
  return { ...actual, appendUsageLog: () => undefined };
});

const { MeteredProvider } = await import("../../../src/ai/meteredProvider");
const { resetAiSequence } = await import("../../../src/core/aiSequence");
import type { AIProvider, ProviderId } from "../../../src/ai/types";

function countingProvider(id: ProviderId) {
  let running = 0;
  let maxRunning = 0;
  const provider: AIProvider = {
    id,
    displayName: id,
    isPaid: false,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return { text: "{}", truncated: false, elapsedMs: 10 };
    },
  };
  return { provider, maxRunning: () => maxRunning };
}

const params = {
  systemPrompt: "指示",
  userPrompt: "本文",
  model: "gemma4:e4b",
  temperature: 0,
  meta: { feature: "typo_check" },
};

beforeEach(() => {
  resetAiSequence();
});

describe("関所を通したときに同時に飛ぶ数", () => {
  test.each(["claude", "sakura", "gemini", "openai"] as ProviderId[])(
    "クラウド（%s）は3本まで",
    async (id) => {
      const { provider, maxRunning } = countingProvider(id);
      const metered = new MeteredProvider(provider);
      await Promise.all(Array.from({ length: 6 }, () => metered.generate(params)));
      expect(maxRunning()).toBe(3);
    }
  );

  test.each(["ollama", "lmstudio"] as ProviderId[])(
    "手元のAI（%s）は1本ずつ",
    async (id) => {
      const { provider, maxRunning } = countingProvider(id);
      const metered = new MeteredProvider(provider);
      await Promise.all(Array.from({ length: 4 }, () => metered.generate(params)));
      expect(maxRunning()).toBe(1);
    }
  );
});
