import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OllamaProvider } from "../../../src/ai/ollamaProvider";
import { setStreamingSettingReader } from "../../../src/ai/ollamaStream";
import {
  MOE_NUM_BATCH,
  NUM_BATCH_MAX_CONTEXT,
  NUM_BATCH_MIN_CONTEXT,
  decideOllamaNumBatch,
} from "../../../src/core/ollamaBatch";
import { useMemoryTuningStore } from "../support/tuningStore";
import { workspace } from "../support/vscodeStub";
import { ndjson } from "../support/aiResponses";

/**
 * 部品を分けたモデル（MoE）が GPU からあふれているときだけ、短い回で
 * `num_batch` を送る（設計書6.53.4。2026-11-27 の実測で 26b の1回が 13.1→9.0秒）。
 *
 * 押さえるのは「速くなる所でだけ送り、ほかでは今までどおり」——全部 GPU に
 * 載るモデル（e4b）と長い回では送らず、`/api/ps` も読まない（往復を増やさない）。
 */

const MODEL = "moe-model";

interface Stub {
  /** `/api/chat` へ送った本文 */
  readonly bodies: Array<Record<string, unknown>>;
  /** `/api/ps` を読んだ回数 */
  readonly psCalls: () => number;
}

interface StubOptions {
  /** `/api/show` に部品の数を載せるか */
  readonly experts: boolean;
  /** `/api/ps` の応答（回ごと。尽きたら最後のものを使う）。"error" は 500 を返す */
  readonly ps: ReadonlyArray<"error" | Array<{ name: string; size: number; size_vram: number }>>;
}

function stubOllama(options: StubOptions): Stub {
  const bodies: Array<Record<string, unknown>> = [];
  let psCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/show")) {
        const modelInfo: Record<string, unknown> = {
          "general.architecture": "test",
          "test.context_length": 131_072,
          ...(options.experts
            ? { "test.expert_count": 128, "test.expert_used_count": 8 }
            : {}),
        };
        return new Response(JSON.stringify({ model_info: modelInfo }), { status: 200 });
      }
      if (url.endsWith("/api/ps")) {
        const reply = options.ps[Math.min(psCalls, options.ps.length - 1)];
        psCalls++;
        if (reply === "error") return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ models: reply ?? [] }), { status: 200 });
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        ndjson([
          { message: { content: "{}" }, done: false },
          { done: true, done_reason: "stop", eval_count: 3, prompt_eval_count: 9 },
        ]),
        { status: 200 }
      );
    })
  );
  return { bodies, psCalls: () => psCalls };
}

const GiB = 1024 ** 3;
/** GPU と CPU に分けて載った（26b の実測の形：size が size_vram より大きい） */
const split = [{ name: MODEL, size: 17 * GiB, size_vram: 7 * GiB }];
/** 全部 GPU に載った */
const onGpu = [{ name: MODEL, size: 5 * GiB, size_vram: 5 * GiB }];

async function send(provider: OllamaProvider, numCtx: number): Promise<void> {
  // 製品のふつうの回は、`num_ctx` を決めるときに `/api/show` を読んで覚えている。
  // ここでは `numCtx` を決め打ちするので、先に読ませておく
  await provider.getModel(MODEL);
  await provider.generate({
    systemPrompt: "指示",
    userPrompt: "本文",
    model: MODEL,
    temperature: 0,
    numCtx,
  });
}

function sentNumBatch(stub: Stub, index: number): unknown {
  return (stub.bodies[index]?.options as Record<string, unknown> | undefined)?.num_batch;
}

const originalConfig = workspace.getConfiguration;

/** 作者の `novelai.ollama.numCtx` だけを差し替える */
function useConfiguredNumCtx(numCtx: number): void {
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, defaultValue: T): T =>
      key === "ollama.numCtx" ? (numCtx as unknown as T) : defaultValue,
  })) as unknown as typeof workspace.getConfiguration;
}

beforeEach(async () => {
  await useMemoryTuningStore({});
  setStreamingSettingReader(() => true);
});

afterEach(() => {
  workspace.getConfiguration = originalConfig;
  vi.unstubAllGlobals();
});

describe("Ollama の num_batch", () => {
  test("部品を分けたモデルが分けて載っていて、16k〜32k の回なら 2048 を送る", async () => {
    const stub = stubOllama({ experts: true, ps: [split] });
    const provider = new OllamaProvider();
    await send(provider, 16_384);
    await send(provider, 32_768);
    expect([0, 1].map((i) => sentNumBatch(stub, i))).toEqual([MOE_NUM_BATCH, MOE_NUM_BATCH]);
  });

  test("下限より短い回（12k 以下。測って速くならなかった）では送らず、/api/ps も読まない", async () => {
    const stub = stubOllama({ experts: true, ps: [split] });
    const provider = new OllamaProvider();
    await send(provider, 8_192);
    await send(provider, 12_288);
    expect([0, 1].map((i) => sentNumBatch(stub, i))).toEqual([undefined, undefined]);
    expect(stub.psCalls()).toBe(0);
  });

  test("num_ctx を呼び出し側が決めないふつうの回（プロバイダが本文から決める）でも送る", async () => {
    const stub = stubOllama({ experts: true, ps: [split] });
    await new OllamaProvider().generate({
      systemPrompt: "指示",
      userPrompt: "本文",
      model: MODEL,
      temperature: 0,
      // 答えの見込みから num_ctx が 16k〜32k の段に決まる（誤字脱字の 8,192 の倍ほど）
      plannedOutputTokens: 16_000,
    });
    const numCtx = (stub.bodies[0]?.options as Record<string, unknown>).num_ctx as number;
    expect(numCtx).toBeGreaterThanOrEqual(16_384);
    expect(numCtx).toBeLessThanOrEqual(32_768);
    expect(sentNumBatch(stub, 0)).toBe(MOE_NUM_BATCH);
  });

  test("作者が num_ctx を設定で決めていても、部品の数を読んで送る", async () => {
    const stub = stubOllama({ experts: true, ps: [split] });
    useConfiguredNumCtx(16_384);
    await new OllamaProvider().generate({
      systemPrompt: "指示",
      userPrompt: "本文",
      model: MODEL,
      temperature: 0,
    });
    expect((stub.bodies[0]?.options as Record<string, unknown>).num_ctx).toBe(16_384);
    expect(sentNumBatch(stub, 0)).toBe(MOE_NUM_BATCH);
  });

  test("全部 GPU に載るモデル（部品を分けない e4b など）では送らず、/api/ps も読まない", async () => {
    const stub = stubOllama({ experts: false, ps: [split] });
    await send(new OllamaProvider(), 16_384);
    expect(sentNumBatch(stub, 0)).toBeUndefined();
    expect(stub.psCalls()).toBe(0);
  });

  test("部品を分けたモデルでも、全部 GPU に載っていれば送らない", async () => {
    const stub = stubOllama({ experts: true, ps: [onGpu] });
    await send(new OllamaProvider(), 16_384);
    expect(sentNumBatch(stub, 0)).toBeUndefined();
  });

  test("長い回（上限を超える num_ctx）では送らず、/api/ps も読まない", async () => {
    const stub = stubOllama({ experts: true, ps: [split] });
    await send(new OllamaProvider(), 65_536);
    expect(sentNumBatch(stub, 0)).toBeUndefined();
    expect(stub.psCalls()).toBe(0);
  });

  test("まだ載っていない最初の回は送らず、分けて載ったのを見た次の回から送る", async () => {
    // 1回目：一覧が空（読み込み前）→ 送らない。2回目：分けて載っている → 送る。
    // 3回目：一覧から消えていても（下ろされた）、この窓で見た載り方で送る
    const stub = stubOllama({ experts: true, ps: [[], split, []] });
    const provider = new OllamaProvider();
    await send(provider, 16_384);
    await send(provider, 16_384);
    await send(provider, 16_384);
    expect([0, 1, 2].map((i) => sentNumBatch(stub, i))).toEqual([
      undefined,
      MOE_NUM_BATCH,
      MOE_NUM_BATCH,
    ]);
  });

  test("/api/ps が読めなくても依頼は止めず、送らないだけ", async () => {
    const stub = stubOllama({ experts: true, ps: ["error"] });
    await send(new OllamaProvider(), 16_384);
    expect(stub.bodies).toHaveLength(1);
    expect(sentNumBatch(stub, 0)).toBeUndefined();
  });
});

describe("decideOllamaNumBatch の境目", () => {
  test("下限・上限ちょうどは送り、1つでも外れたら送らない", () => {
    const base = { mixtureOfExperts: true, splitAcrossCpu: true } as const;
    expect(decideOllamaNumBatch({ ...base, numCtx: NUM_BATCH_MIN_CONTEXT })).toBe(MOE_NUM_BATCH);
    expect(decideOllamaNumBatch({ ...base, numCtx: NUM_BATCH_MIN_CONTEXT - 1 })).toBeUndefined();
    expect(decideOllamaNumBatch({ ...base, numCtx: NUM_BATCH_MAX_CONTEXT })).toBe(MOE_NUM_BATCH);
    expect(decideOllamaNumBatch({ ...base, numCtx: NUM_BATCH_MAX_CONTEXT + 1 })).toBeUndefined();
  });

  test("載り方が分からなければ送らない", () => {
    expect(
      decideOllamaNumBatch({ numCtx: 16_384, mixtureOfExperts: true, splitAcrossCpu: undefined })
    ).toBeUndefined();
  });
});
