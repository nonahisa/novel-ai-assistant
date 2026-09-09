import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import { ClaudeProvider } from "../../src/ai/claudeProvider";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import { contextSizeForPrompt } from "../../src/core/chunker";
import { OUTPUT_RESERVE_TOKENS } from "../../src/ai/contextGuard";
import { OpenAIProvider } from "../../src/ai/openaiProvider";
import { GeminiProvider } from "../../src/ai/geminiProvider";
import { LmStudioProvider } from "../../src/ai/lmstudioProvider";
import { SakuraProvider } from "../../src/ai/sakuraProvider";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../src/ai/outputLimit";
import { workspace } from "./support/vscodeStub";

/**
 * 出力トークンの2つの欄を、全プロバイダが同じように扱う（設計書6.77の第2段）。
 *
 * ## なぜ2つに分かれているのか
 *
 * `maxOutputTokens` は**実際に上限として送る値**、`plannedOutputTokens` は
 * **場所を空けるために見込む値**である。以前は1つの欄しか無く、しかも
 * それを見ていたのは**Ollamaだけ**だった。ほかの5つは渡された値を捨てて、
 * 常にグローバル設定（`novelai.maxOutputTokens`、既定16,384）を送っていた。
 *
 * 5つに「渡された値を尊重させる」だけでは足りない。機能が渡していたのは
 * **見込み**（測っていないモデルでは8,192で頭打ち）なので、そのまま
 * 上限になると**実際の上限が設定値の半分になり、長い応答が途中で切れる。**
 * 抽出のJSONは切れると解析できず、そのチャンクが丸ごと捨てられる。
 * だから欄そのものを2つに分けた。
 *
 * ## 何を固定するか
 *
 * 1. `maxOutputTokens` は、そのままAPIの該当欄へ載る
 * 2. 渡されなければ、これまでどおり設定値を送る（後方互換）
 * 3. `plannedOutputTokens` は**上限として送らない**（場所の確保だけ）
 * 4. Ollamaの `num_ctx` は、見込み → 実上限 → 既定8,192 の順で決まる
 *
 * 送り先の欄はプロバイダごとに名前が違う（`max_tokens` /
 * `max_completion_tokens` / `generationConfig.maxOutputTokens`）ので、
 * 「渡した値が実際に載ったか」は**送信本文を覗いて**確かめる。
 */

/** APIキーと記憶場所を持っているふりをする */
function fakeContext(): ExtensionContext {
  const stored = new Map<string, unknown>();
  return {
    secrets: {
      get: async () => "test-api-key-0123456789",
      store: async () => undefined,
      delete: async () => undefined,
    },
    globalState: {
      get: (key: string) => stored.get(key),
      update: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
    },
  } as unknown as ExtensionContext;
}

const params = {
  systemPrompt: "指示",
  userPrompt: "本文",
  model: "test-model",
  temperature: 0.2,
};

/**
 * モデルの申告上限。**設定値より大きくしておく**——ここを小さくすると
 * `clampToModelLimit` が効いてしまい、「渡した値が効いたのか、
 * 申告上限で丸められたのか」が区別できない。
 */
const claudeModel = {
  id: "test-model",
  type: "model",
  display_name: "Test model",
  max_tokens: 64_000,
  capabilities: {
    structured_outputs: { supported: false },
    thinking: { supported: false },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openAiChat() {
  return {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function claudeMessage() {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function geminiChat() {
  return {
    candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  };
}

/**
 * 送信本文を溜める `fetch` を立てる。
 *
 * モデル情報の問い合わせ（Claudeの `/v1/models/`、LM Studioの
 * `/api/v0/models`）は生成の本文ではないので、`bodies` へ積まない。
 */
function stubFetch(reply: () => unknown): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) return jsonResponse(claudeModel);
      if (url.includes("/api/v0/models")) return jsonResponse({ data: [] });
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return jsonResponse(reply());
    })
  );
  return bodies;
}

describe("出力トークン上限は、渡されたらそれを送る（設計書6.77）", () => {
  beforeEach(() => {
    // 設定は既定のまま（`novelai.maxOutputTokens` は 16,384）
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("Claude：渡された値を max_tokens として送る", async () => {
    const bodies = stubFetch(claudeMessage);

    await new ClaudeProvider(fakeContext()).generate({
      ...params,
      maxOutputTokens: 4_096,
    });

    expect(bodies[0].max_tokens).toBe(4_096);
  });

  test("Claude：渡されなければ設定値を送る（従来どおり）", async () => {
    const bodies = stubFetch(claudeMessage);

    await new ClaudeProvider(fakeContext()).generate(params);

    expect(bodies[0].max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("ChatGPT：渡された値を max_completion_tokens として送る", async () => {
    const bodies = stubFetch(openAiChat);

    await new OpenAIProvider(fakeContext()).generate({
      ...params,
      maxOutputTokens: 4_096,
    });

    expect(bodies[0].max_completion_tokens).toBe(4_096);
  });

  test("ChatGPT：渡されなければ設定値を送る（従来どおり）", async () => {
    const bodies = stubFetch(openAiChat);

    await new OpenAIProvider(fakeContext()).generate(params);

    expect(bodies[0].max_completion_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("LM Studio：渡された値を max_tokens として送る", async () => {
    const bodies = stubFetch(openAiChat);

    await new LmStudioProvider().generate({
      ...params,
      maxOutputTokens: 4_096,
    });

    expect(bodies[0].max_tokens).toBe(4_096);
  });

  test("LM Studio：渡されなければ設定値を送る（従来どおり）", async () => {
    const bodies = stubFetch(openAiChat);

    await new LmStudioProvider().generate(params);

    expect(bodies[0].max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("さくらのAI：渡された値を max_tokens として送る", async () => {
    const bodies = stubFetch(openAiChat);

    await new SakuraProvider(fakeContext()).generate({
      ...params,
      maxOutputTokens: 4_096,
    });

    expect(bodies[0].max_tokens).toBe(4_096);
  });

  test("さくらのAI：渡されなければ設定値を送る（従来どおり）", async () => {
    const bodies = stubFetch(openAiChat);

    await new SakuraProvider(fakeContext()).generate(params);

    expect(bodies[0].max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("Gemini：渡された値を generationConfig.maxOutputTokens として送る", async () => {
    const bodies = stubFetch(geminiChat);

    await new GeminiProvider(fakeContext()).generate({
      ...params,
      maxOutputTokens: 4_096,
    });

    const config = bodies[0].generationConfig as Record<string, unknown>;
    expect(config.maxOutputTokens).toBe(4_096);
  });

  test("Gemini：渡されなければ設定値を送る（従来どおり）", async () => {
    const bodies = stubFetch(geminiChat);

    await new GeminiProvider(fakeContext()).generate(params);

    const config = bodies[0].generationConfig as Record<string, unknown>;
    expect(config.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("Claude：渡された値でも、モデルの申告上限は超えない", async () => {
    // 丸めの順番を変えていないことの裏取り。渡された値をそのまま信じて
    // 申告上限を超えると、Anthropicは400で断る（課金だけされる）
    const bodies = stubFetch(claudeMessage);

    await new ClaudeProvider(fakeContext()).generate({
      ...params,
      maxOutputTokens: 100_000,
    });

    expect(bodies[0].max_tokens).toBe(64_000);
  });
});

/**
 * **見込み（`plannedOutputTokens`）は上限として送らない。**
 *
 * ここが2つの欄を分けた目的そのものである。見込みが上限になると、
 * 「非力な機械のために確保を減らす」つもりの値が「そこまでしか書くな」に
 * すり替わる。
 */
describe("見込みは場所を空けるだけで、上限にはならない（設計書6.77）", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("Claude：見込みだけを渡しても、上限は設定値のまま", async () => {
    const bodies = stubFetch(claudeMessage);

    await new ClaudeProvider(fakeContext()).generate({
      ...params,
      plannedOutputTokens: 2_000,
    });

    expect(bodies[0].max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("ChatGPT：見込みだけを渡しても、上限は設定値のまま", async () => {
    const bodies = stubFetch(openAiChat);

    await new OpenAIProvider(fakeContext()).generate({
      ...params,
      plannedOutputTokens: 2_000,
    });

    expect(bodies[0].max_completion_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("LM Studio：見込みだけを渡しても、上限は設定値のまま", async () => {
    const bodies = stubFetch(openAiChat);

    await new LmStudioProvider().generate({
      ...params,
      plannedOutputTokens: 2_000,
    });

    expect(bodies[0].max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("さくらのAI：見込みだけを渡しても、上限は設定値のまま", async () => {
    const bodies = stubFetch(openAiChat);

    await new SakuraProvider(fakeContext()).generate({
      ...params,
      plannedOutputTokens: 2_000,
    });

    expect(bodies[0].max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("Gemini：見込みだけを渡しても、上限は設定値のまま", async () => {
    const bodies = stubFetch(geminiChat);

    await new GeminiProvider(fakeContext()).generate({
      ...params,
      plannedOutputTokens: 2_000,
    });

    const config = bodies[0].generationConfig as Record<string, unknown>;
    expect(config.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});

/**
 * Ollamaの `num_ctx` は、**見込み → 実上限 → 既定8,192** の順で決まる。
 *
 * **従来と同じ数値になることを固定する。** 12機能は見込みを渡し続けるので、
 * 確保する長さはこれまでどおりでなければならない——ここが実上限
 * （測っていないモデルでは設定値16,384）に変わると、`num_ctx` が倍近くに
 * 育って非力な機械のメモリを食う（設計書6.58.2で避けた副作用）。
 */
describe("Ollamaが確保する長さ（設計書6.77）", () => {
  const CONTEXT_WINDOW = 131_072;

  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** その回に送られた `num_ctx` を取る */
  async function sentNumCtx(
    extra: Record<string, number>
  ): Promise<number> {
    let numCtx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/show")) {
          return jsonResponse({
            model_info: { "gemma4.context_length": CONTEXT_WINDOW },
          });
        }
        numCtx = JSON.parse(String(init?.body)).options.num_ctx;
        return jsonResponse({
          message: { content: "ok" },
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 5,
        });
      })
    );
    await new OllamaProvider().generate({ ...params, ...extra });
    return numCtx;
  }

  /** 見込みの値から、確保されるはずの長さを出す（式は本物と同じものを使う） */
  function expected(outputTokens: number): number {
    return contextSizeForPrompt({
      promptChars: params.systemPrompt.length + params.userPrompt.length,
      outputTokens,
      contextWindow: CONTEXT_WINDOW,
    });
  }

  test("見込みが渡されれば、それで確保する（実上限が大きくても引きずられない）", async () => {
    expect(await sentNumCtx({ plannedOutputTokens: 4_096, maxOutputTokens: 16_384 }))
      .toBe(expected(4_096));
  });

  test("見込みが無ければ、実上限で確保する", async () => {
    expect(await sentNumCtx({ maxOutputTokens: 4_096 })).toBe(expected(4_096));
  });

  test("どちらも無ければ、既定の8,192で確保する（従来どおり）", async () => {
    expect(await sentNumCtx({})).toBe(expected(OUTPUT_RESERVE_TOKENS));
  });

  test("Ollamaは「上限を掛けない」と名乗る（関所がそれを見る）", async () => {
    // **プロバイダIDでの分岐を避けるための印である**（設計書6.77の第2段）。
    // LM Studio のようにOllama互換の口を持つものがあり、名前は当てにならない
    expect(new OllamaProvider().capsOutput).toBe(false);
  });

  test.each([
    ["Claude", () => new ClaudeProvider(fakeContext())],
    ["ChatGPT", () => new OpenAIProvider(fakeContext())],
    ["LM Studio", () => new LmStudioProvider()],
    ["さくらのAI", () => new SakuraProvider(fakeContext())],
    ["Gemini", () => new GeminiProvider(fakeContext())],
  ])("%s は上限を掛ける側（印を持たない＝既定のまま）", (_name, make) => {
    expect(make().capsOutput).toBeUndefined();
  });

  test("見込みを渡しても、num_predict は送らない（上限を掛けない方針は不変）", async () => {
    // 設計書6.58.2。上限を掛けると長い応答が途中で切れ、
    // 抽出のJSONが解析できずそのチャンクが丸ごと捨てられる
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/show")) {
          return jsonResponse({
            model_info: { "gemma4.context_length": CONTEXT_WINDOW },
          });
        }
        body = JSON.parse(String(init?.body));
        return jsonResponse({
          message: { content: "ok" },
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 5,
        });
      })
    );

    await new OllamaProvider().generate({
      ...params,
      plannedOutputTokens: 4_096,
      maxOutputTokens: 16_384,
    });

    expect((body.options as Record<string, unknown>).num_predict).toBeUndefined();
  });
});
