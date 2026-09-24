import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 関所（`MeteredProvider`）が、手元のAIへ送る前に「プロセスをまたいだ門」
 * （設計書6.76.1）を通ること。
 *
 * - **手元のAI（Ollama・LM Studio）だけ**が門を通る。クラウドは通らない
 * - 順番は「門 → 関所」。**門で待っている間も、同じ窓のクラウドへの送信は進む**
 *   （関所を持ったまま門で待つと、別の窓の完了をクラウドまで待たされる）
 * - 門の「やめる」・中止は `aborted` として返る。**それ以外の門の失敗では止めない**
 * - 送り終えたら（失敗しても）門の抜け口を必ず呼ぶ
 */

vi.mock("../../../src/core/usageLog", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/core/usageLog")>();
  return { ...actual, appendUsageLog: () => undefined };
});

const { MeteredProvider } = await import("../../../src/ai/meteredProvider");
const { AIError } = await import("../../../src/ai/types");
const { resetAiSequence, AiQueueAbortError } = await import(
  "../../../src/core/aiSequence"
);
const { setLocalAiGate } = await import("../../../src/core/localAiGate");
import type { AIProvider, GenerateResult, ProviderId } from "../../../src/ai/types";
import type { LocalAiGateRequest } from "../../../src/core/localAiGate";

function provider(id: ProviderId, generate?: () => Promise<GenerateResult>): AIProvider {
  return {
    id,
    displayName: id,
    isPaid: false,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate:
      generate ??
      (async () => ({ text: "{}", truncated: false, elapsedMs: 10 })),
  };
}

const params = {
  systemPrompt: "指示",
  userPrompt: "本文",
  model: "gemma4:e4b",
  temperature: 0,
  meta: { feature: "typo_check" },
};

function recordingGate(enter: (request: LocalAiGateRequest) => Promise<() => void>) {
  const requests: LocalAiGateRequest[] = [];
  let runEnded = 0;
  setLocalAiGate({
    enter: (request) => {
      requests.push(request);
      return enter(request);
    },
    runEnded: () => void (runEnded += 1),
  });
  return { requests, runEnded: () => runEnded };
}

beforeEach(() => {
  resetAiSequence();
});

afterEach(() => {
  setLocalAiGate(undefined);
});

describe("手元のAIだけが門を通る", () => {
  test("Ollama と LM Studio は通り、送り終えたら抜ける", async () => {
    let left = 0;
    const gate = recordingGate(async () => () => void (left += 1));
    await new MeteredProvider(provider("ollama")).generate(params);
    await new MeteredProvider(provider("lmstudio")).generate(params);
    expect(gate.requests.map((request) => request.providerId)).toEqual([
      "ollama",
      "lmstudio",
    ]);
    expect(gate.requests[0]).toMatchObject({ model: "gemma4:e4b", feature: "typo_check" });
    expect(left).toBe(2);
  });

  test("クラウドは通らない", async () => {
    const gate = recordingGate(async () => () => undefined);
    await new MeteredProvider(provider("gemini")).generate(params);
    await new MeteredProvider(provider("sakura")).generate(params);
    expect(gate.requests).toEqual([]);
  });

  test("門が無ければ今までどおり送る", async () => {
    const result = await new MeteredProvider(provider("ollama")).generate(params);
    expect(result.text).toBe("{}");
  });
});

describe("順番（門 → 関所）", () => {
  test("門で待っている間も、同じ窓のクラウドへの送信は進む", async () => {
    let open: () => void = () => undefined;
    recordingGate(
      () =>
        new Promise((resolve) => {
          open = () => resolve(() => undefined);
        })
    );
    let localDone = false;
    const local = new MeteredProvider(provider("ollama"))
      .generate(params)
      .then(() => (localDone = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 門で止まっている手元のAIを追い越して、クラウドは送れる
    const cloud = await new MeteredProvider(provider("gemini")).generate(params);
    expect(cloud.text).toBe("{}");
    expect(localDone).toBe(false);
    open();
    await local;
    expect(localDone).toBe(true);
  });
});

describe("門の失敗の扱い", () => {
  test("［やめる］・中止は aborted で返り、AIへは送らない", async () => {
    let sent = false;
    recordingGate(async () => {
      throw new AiQueueAbortError("GPU の負荷が高いため、送るのをやめました。");
    });
    const error = await new MeteredProvider(
      provider("ollama", async () => {
        sent = true;
        return { text: "{}", truncated: false, elapsedMs: 1 };
      })
    )
      .generate(params)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AIError);
    expect((error as InstanceType<typeof AIError>).kind).toBe("aborted");
    expect((error as Error).message).toBe("GPU の負荷が高いため、送るのをやめました。");
    expect(sent).toBe(false);
  });

  test("それ以外の門の失敗では止めない（札が壊れていても送る）", async () => {
    recordingGate(async () => {
      throw new Error("札のファイルが読めません");
    });
    const result = await new MeteredProvider(provider("ollama")).generate(params);
    expect(result.text).toBe("{}");
  });

  test("AIが失敗しても、門の抜け口は呼ぶ", async () => {
    let left = 0;
    recordingGate(async () => () => void (left += 1));
    await expect(
      new MeteredProvider(
        provider("ollama", async () => {
          throw new AIError("落ちました", "bad_response");
        })
      ).generate(params)
    ).rejects.toBeInstanceOf(AIError);
    expect(left).toBe(1);
  });
});
