import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 推敲の指摘への短い助言（P-47）の呼び出し（`features/findingAdvice.ts`）。
 *
 * - 割当は「相談」に従う（2026-10-08 作者の裁定。旧は推敲）
 * - 同じ指摘・同じ本文・同じプロバイダとモデル・同じ版なら作り直さない（規則4）。
 *   当たったときは繋がるかの確認も課金の確認もしない
 * - 検証を通らなかった答え・失敗はキャッシュに入れない
 * - ［止める］（中止）は失敗ではなく cancelled
 * - Ollama 向けにスキーマを渡し、思考を止める（規則6）
 */

/** キャッシュの中身（ファイルの代わり）。鍵は `chunkCacheStore` と同じ材料で作る */
const cacheEntries = new Map<string, unknown>();

vi.mock("../../../src/core/chunkCache", () => ({
  ChunkCache: class {
    async load() {}
    async save() {}
    get(hash: string, base: Record<string, string>) {
      return cacheEntries.get(
        `${base.feature}|${base.promptVersion}|${base.providerId}|${base.model}|${hash}`
      );
    }
    async set(hash: string, base: Record<string, string>, value: unknown) {
      cacheEntries.set(
        `${base.feature}|${base.promptVersion}|${base.providerId}|${base.model}|${hash}`,
        value
      );
    }
  },
}));

const connectivity = vi.hoisted(() => ({
  reachable: vi.fn(async () => true),
  paid: vi.fn(async () => true),
}));
vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: connectivity.reachable,
  confirmPaidUsage: connectivity.paid,
}));

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  responseExcerptForLog: (text: string) => text,
  useLogFile: vi.fn(),
}));

vi.mock("../../../src/ai/outputLimit", () => ({
  resolveOutputTokensForSend: () => 400,
  resolveOutputTokensForPlanning: () => 400,
}));

const { askFindingAdvice } = await import("../../../src/features/findingAdvice");
const { AIError } = await import("../../../src/ai/types");
const { FINDING_ADVICE_SCHEMA } = await import("../../../src/prompts/findingAdvice");

const WORK = {
  id: "w1",
  title: "氷の街",
  folderPath: "C:/novels/ice",
  registeredAt: "2026-10-05T00:00:00.000Z",
};

const material = {
  quote: "　彼女は外を見ている彼女を見ていた。",
  finding: "視点：ここだけ語り手が外から見ています",
  before: "　窓の外は雪だった。",
  after: "　鐘が鳴った。",
};

const GOOD = JSON.stringify({
  point: "同じ「彼女」が2度出て、誰が誰を見ているか迷います。",
  examples: [{ from: "見ている彼女を", to: "窓辺の自分を" }],
});

function registryWith(model: string, generate: ReturnType<typeof vi.fn>) {
  const resolve = vi.fn(() => ({
    provider: {
      id: "ollama",
      displayName: "Ollama",
      isPaid: false,
      generate,
    },
    model,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { registry: { resolve } as any, resolve };
}

beforeEach(() => {
  cacheEntries.clear();
  connectivity.reachable.mockClear();
  connectivity.paid.mockClear();
});

describe("呼び出し", () => {
  test("相談の割当で、スキーマ・思考なしで呼び、検証を通った答えを返す", async () => {
    const generate = vi.fn(async () => ({ text: GOOD }));
    const { registry, resolve } = registryWith("gemma4:e4b", generate);

    const outcome = await askFindingAdvice({ work: WORK, registry, material });

    expect(resolve).toHaveBeenCalledWith("chat");
    expect(generate).toHaveBeenCalledTimes(1);
    const params = (generate.mock.calls[0] as unknown[] | undefined)?.[0] as Record<
      string,
      unknown
    >;
    expect(params.jsonSchema).toBe(FINDING_ADVICE_SCHEMA);
    expect(params.disableThinking).toBe(true);
    expect(String(params.userPrompt)).toContain(material.finding);
    expect(outcome).toEqual({
      kind: "answered",
      cached: false,
      advice: {
        point: "同じ「彼女」が2度出て、誰が誰を見ているか迷います。",
        examples: [{ from: "見ている彼女を", to: "窓辺の自分を" }],
        noNeed: false,
        dropped: 0,
      },
    });
  });

  test("推敲と相談に別のAIを割り当てたら、相談のAIで呼ぶ（2026-10-08 作者の裁定）", async () => {
    const proofreadGenerate = vi.fn(async () => ({ text: GOOD }));
    const chatGenerate = vi.fn(async () => ({ text: GOOD }));
    const byFeature: Record<string, { id: string; generate: typeof proofreadGenerate; model: string }> = {
      proofread: { id: "ollama", generate: proofreadGenerate, model: "gemma4:e4b" },
      chat: { id: "gemini", generate: chatGenerate, model: "gemini-flash" },
    };
    const registry = {
      resolve: vi.fn((feature: string) => {
        const entry = byFeature[feature];
        if (!entry) return undefined;
        return {
          provider: { id: entry.id, displayName: entry.id, isPaid: false, generate: entry.generate },
          model: entry.model,
        };
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await askFindingAdvice({ work: WORK, registry: registry as any, material });

    expect(outcome.kind).toBe("answered");
    expect(chatGenerate).toHaveBeenCalledTimes(1);
    expect(proofreadGenerate).not.toHaveBeenCalled();
    // 有料の確認は相談のAI・モデルで出る（`ai.paid.findingAdvice` の鍵は変えない）
    const paidCall = connectivity.paid.mock.calls[0] as unknown[] | undefined;
    expect((paidCall?.[0] as { id: string }).id).toBe("gemini");
    expect(paidCall?.[1]).toMatchObject({
      remember: { id: "ai.paid.findingAdvice" },
      model: "gemini-flash",
    });
  });

  test("AIが未設定なら呼ばずに cancelled", async () => {
    const outcome = await askFindingAdvice({
      work: WORK,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registry: { resolve: () => undefined } as any,
      material,
    });
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  test("課金の確認で断られたら呼ばない", async () => {
    connectivity.paid.mockResolvedValueOnce(false);
    const generate = vi.fn(async () => ({ text: GOOD }));
    const { registry } = registryWith("gemma4:e4b", generate);

    const outcome = await askFindingAdvice({ work: WORK, registry, material });
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(generate).not.toHaveBeenCalled();
  });

  test("［止める］で中止されたら cancelled（失敗として出さない）", async () => {
    const generate = vi.fn(async () => {
      throw new AIError("中止しました", "aborted");
    });
    const { registry } = registryWith("gemma4:e4b", generate);
    const outcome = await askFindingAdvice({ work: WORK, registry, material });
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  test("読めない答えは failed で、1文の理由を返す", async () => {
    const generate = vi.fn(async () => ({
      text: JSON.stringify({ point: "何が引っかかっているか", examples: [] }),
    }));
    const { registry } = registryWith("gemma4:e4b", generate);
    const outcome = await askFindingAdvice({ work: WORK, registry, material });
    expect(outcome).toEqual({ kind: "failed", reason: "AIの答えを読み取れませんでした。" });
  });

  test("途中で切れた答えは failed", async () => {
    const generate = vi.fn(async () => ({ text: GOOD, truncated: true }));
    const { registry } = registryWith("gemma4:e4b", generate);
    const outcome = await askFindingAdvice({ work: WORK, registry, material });
    expect(outcome.kind).toBe("failed");
  });
});

describe("キャッシュ（規則4）", () => {
  test("同じ指摘・同じ本文・同じモデルなら、2回目はAIも確認も呼ばない", async () => {
    const generate = vi.fn(async () => ({ text: GOOD }));
    const { registry } = registryWith("gemma4:e4b", generate);

    await askFindingAdvice({ work: WORK, registry, material });
    connectivity.reachable.mockClear();
    connectivity.paid.mockClear();
    const second = await askFindingAdvice({ work: WORK, registry, material });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(connectivity.reachable).not.toHaveBeenCalled();
    expect(connectivity.paid).not.toHaveBeenCalled();
    expect(second).toMatchObject({ kind: "answered", cached: true });
  });

  test("モデルが違えば作り直す", async () => {
    const generate = vi.fn(async () => ({ text: GOOD }));
    await askFindingAdvice({ work: WORK, registry: registryWith("gemma4:e4b", generate).registry, material });
    await askFindingAdvice({ work: WORK, registry: registryWith("gemma4:26b", generate).registry, material });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  test("本文（一文・前後）や指摘が変われば作り直す", async () => {
    const generate = vi.fn(async () => ({ text: GOOD }));
    const { registry } = registryWith("gemma4:e4b", generate);
    await askFindingAdvice({ work: WORK, registry, material });
    await askFindingAdvice({
      work: WORK,
      registry,
      material: { ...material, after: "　鐘が二度鳴った。" },
    });
    await askFindingAdvice({
      work: WORK,
      registry,
      material: { ...material, finding: "係り受け：主語が遠い" },
    });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  test("読めなかった答えは覚えない（次はもう一度訊く）", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: "{}" })
      .mockResolvedValueOnce({ text: GOOD });
    const { registry } = registryWith("gemma4:e4b", generate);
    const first = await askFindingAdvice({ work: WORK, registry, material });
    const second = await askFindingAdvice({ work: WORK, registry, material });
    expect(first.kind).toBe("failed");
    expect(second).toMatchObject({ kind: "answered", cached: false });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
