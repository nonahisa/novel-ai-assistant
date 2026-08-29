import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import {
  ClaudeProvider,
  toClaudeAIError,
  toClaudeJsonSchema,
} from "../../src/ai/claudeProvider";
import { OpenAIProvider } from "../../src/ai/openaiProvider";
import { GeminiProvider } from "../../src/ai/geminiProvider";
import { LmStudioProvider } from "../../src/ai/lmstudioProvider";
import { AIError } from "../../src/ai/types";
import { workspace } from "./support/vscodeStub";

const ollamaParams = {
  systemPrompt: "system",
  userPrompt: "user",
  model: "test-model",
  temperature: 0.2,
  numCtx: 16384,
};

function ollamaResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      message: { content },
      done_reason: "stop",
      prompt_eval_count: 100,
      eval_count: 20,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function claudeContext(): ExtensionContext {
  // モデルごとの対応状況を覚える置き場。テストごとに独立させる
  const stored = new Map<string, unknown>();
  return {
    secrets: {
      get: async () => "test-api-key",
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

const claudeModel = {
  id: "test-model",
  type: "model",
  display_name: "Test model",
  created_at: "2026-01-01T00:00:00Z",
  max_input_tokens: 200000,
  max_tokens: 8192,
  capabilities: {
    batch: { supported: false },
    citations: { supported: false },
    code_execution: { supported: false },
    context_management: {
      supported: false,
      clear_thinking_20251015: null,
      clear_tool_uses_20250919: null,
      compact_20260112: null,
    },
    effort: {
      supported: false,
      high: { supported: false },
      medium: { supported: false },
      low: { supported: false },
      max: { supported: false },
      xhigh: null,
    },
    image_input: { supported: false },
    pdf_input: { supported: false },
    structured_outputs: { supported: false },
    thinking: {
      supported: true,
      types: {
        adaptive: { supported: true },
        enabled: { supported: true },
      },
    },
  },
};

function claudeMessage(
  content: string,
  stopReason: "end_turn" | "refusal" | null = "end_turn"
) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: content ? [{ type: "text", text: content }] : [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AIプロバイダ境界", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("Ollamaへコンテキスト長・JSONスキーマ・思考無効を送る", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.options.num_ctx).toBe(16384);
      expect(body.format).toEqual({ type: "object" });
      expect(body.think).toBe(false);
      return new Response(
        JSON.stringify({
          message: { content: '{"characters":[]}' },
          done_reason: "stop",
          prompt_eval_count: 100,
          eval_count: 20,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OllamaProvider().generate({
      systemPrompt: "system",
      userPrompt: "user",
      model: "test-model",
      temperature: 0.2,
      numCtx: 16384,
      jsonSchema: { type: "object" },
      disableThinking: true,
    });

    expect(result.text).toBe('{"characters":[]}');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(result.truncated).toBe(false);
  });

  test("numCtxを渡さない呼び出しでも、プロンプトが収まる大きさを確保する", async () => {
    // generate の呼び出し15か所のうち11か所が numCtx を渡しておらず、
    // 既定の 8192 のまま送っていた（0.22.14で判明）。チャンクはモデル可変で
    // 20,000字になりうるので、入力が黙って切り捨てられる
    const longPrompt = "あ".repeat(30000);
    let sentNumCtx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/show")) {
          return jsonResponse({ model_info: { "gemma4.context_length": 131072 } });
        }
        sentNumCtx = JSON.parse(String(init?.body)).options.num_ctx;
        return ollamaResponse("ok");
      })
    );

    await new OllamaProvider().generate({
      systemPrompt: "system",
      userPrompt: longPrompt,
      model: "test-model",
      temperature: 0.2,
    });

    // 日本語1文字あたり 1/0.7 トークンと見積もる。30,000字は約42,858トークン
    expect(sentNumCtx).toBeGreaterThanOrEqual(Math.ceil(30000 / 0.7));
    // モデルの上限は超えない（超えた分はモデル側で黙って切り捨てられる）
    expect(sentNumCtx).toBeLessThanOrEqual(131072);
  });

  test("numCtxを明示した呼び出しは、その値のまま送る（見積りへ回さない）", async () => {
    // 明示している4か所は送るものを分かったうえで決めている。
    // 見積りで上書きすると、そちらの積み上げが無意味になる
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/show")) {
        return jsonResponse({ model_info: { "gemma4.context_length": 131072 } });
      }
      expect(JSON.parse(String(init?.body)).options.num_ctx).toBe(16384);
      return ollamaResponse("ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    await new OllamaProvider().generate({
      ...ollamaParams,
      userPrompt: "あ".repeat(30000),
    });

    // /api/show を引きにいかない。明示経路の挙動は一切変わらない
    expect(fetchMock.mock.calls.every(([url]) => !url.endsWith("/api/show"))).toBe(
      true
    );
  });

  test("モデル情報が取れないときは8192で頭打ちになる（従来と同じ）", async () => {
    // /api/show が失敗しても悪化はさせない。従来の固定値と同じ値に落ちる
    let sentNumCtx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/show")) {
          return new Response("", { status: 500 });
        }
        sentNumCtx = JSON.parse(String(init?.body)).options.num_ctx;
        return ollamaResponse("ok");
      })
    );

    await new OllamaProvider().generate({
      systemPrompt: "system",
      userPrompt: "あ".repeat(30000),
      model: "test-model",
      temperature: 0.2,
    });

    expect(sentNumCtx).toBe(8192);
  });

  test("Claude用スキーマへnull許容とadditionalProperties禁止を再帰変換する", () => {
    expect(
      toClaudeJsonSchema({
        type: "object",
        properties: {
          value: { type: ["string", "null"] },
          nested: { type: "object", properties: { id: { type: "string" } } },
        },
      })
    ).toEqual({
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "null" }] },
        nested: {
          type: "object",
          properties: { id: { type: "string" } },
          additionalProperties: false,
          // 必須でない項目には総数の上限があり、超えると要求ごと拒否される
          required: ["id"],
        },
      },
      additionalProperties: false,
      required: ["value", "nested"],
    });
  });

  test("Ollamaは呼び出し元のキャンセルをabortedとして返す", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("中止", "AbortError");
    }));

    await expect(
      new OllamaProvider().generate({ ...ollamaParams, signal: controller.signal })
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  test("Ollamaは開始前に中止されたsignalをfetchへ中止済みで渡す", async () => {
    const controller = new AbortController();
    controller.abort();
    let receivedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      if (receivedSignal?.aborted) {
        throw new DOMException("中止", "AbortError");
      }
      return ollamaResponse("ok");
    }));

    await expect(
      new OllamaProvider().generate({ ...ollamaParams, signal: controller.signal })
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("Ollamaは内部タイムアウトによる中止をtimeoutとして返す", async () => {
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        key === "ollama.timeoutSeconds" ? (0 as T) : defaultValue,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("中止", "AbortError"));
          });
        })
      )
    );

    await expect(new OllamaProvider().generate(ollamaParams)).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  test("Ollamaはtimeout後の呼び出し元キャンセル競合でもtimeoutを返す", async () => {
    vi.useFakeTimers();
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        key === "ollama.timeoutSeconds" ? (1 as T) : defaultValue,
    });
    const caller = new AbortController();
    const pending = deferred<Response>();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return pending.promise;
    }));

    const request = new OllamaProvider().generate({ ...ollamaParams, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSignal?.aborted).toBe(true);
    caller.abort();
    pending.reject(new DOMException("中止", "AbortError"));

    await expect(request).rejects.toMatchObject({ kind: "timeout" });
  });

  test("Ollamaは完了後にタイマーと呼び出し元のlistenerを解除する", async () => {
    vi.useFakeTimers();
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        key === "ollama.timeoutSeconds" ? (1 as T) : defaultValue,
    });
    const caller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return ollamaResponse("ok");
    }));

    await expect(
      new OllamaProvider().generate({ ...ollamaParams, signal: caller.signal })
    ).resolves.toMatchObject({ text: "ok" });
    caller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSignal?.aborted).toBe(false);
  });

  test.each([
    [404, "model_not_found"],
    [500, "bad_response"],
  ])("OllamaのHTTP %iを%sとして返す", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("error", { status })));

    await expect(new OllamaProvider().generate(ollamaParams)).rejects.toMatchObject({ kind });
  });

  test("Ollamaは空白だけの応答をbad_responseとして返す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ollamaResponse(" \n\t ")));

    await expect(new OllamaProvider().generate(ollamaParams)).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  test.each([
    ["壊れたJSON", new Response("{", { status: 200 })],
    ["nullの応答envelope", new Response("null", { status: 200 })],
  ])("Ollamaは%sをbad_responseとして返す", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(new OllamaProvider().generate(ollamaParams)).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  /**
   * `toClaudeAIError` は、公式SDKを外したので**もうSDKの型付き例外を
   * 見分けない**（設計書5.8.5）。HTTPの状態からAIErrorへ変換するのは
   * `httpClient.ts` の `toStatusError` の仕事で、そちらは
   * `aiProviderSchemas.test.ts` が別に確かめている。ここで見るのは
   * 「`fetchJson` が投げたAIErrorはそのまま通す」「それ以外（想定していない
   * 例外）は生の文言を漏らさず unknown へ丸める」の2つだけ。
   */
  test("fetchJsonが投げたAIErrorはそのまま通す", () => {
    const error = new AIError("Claudeのレート上限に達しました。", "rate_limited", "詳細");
    expect(toClaudeAIError(error)).toBe(error);
  });

  test.each([
    ["Error", new Error("gateway returned credential=secret-value")],
    ["SyntaxError", new SyntaxError("local programmer error")],
    ["文字列", "raw string thrown"],
  ])("想定していない例外（%s）は、生の文言を漏らさずunknownへ丸める", (_label, thrown) => {
    const result = toClaudeAIError(thrown);
    expect(result.kind).toBe("unknown");
    if (thrown instanceof Error) {
      expect(result.message).not.toContain(thrown.message);
    }
  });

  test("Claude接続確認はSDKの生エラーをUIメッセージに含めない", async () => {
    const rawMessage = "gateway returned credential=secret-value";
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(
        { type: "error", error: { type: "api_error", message: rawMessage } },
        500
      )
    ));

    const result = await new ClaudeProvider(claudeContext()).testConnection();

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(rawMessage);
  });

  test("Claudeは開始前の中止でメタデータ取得を始めない", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => jsonResponse(claudeModel));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ClaudeProvider(claudeContext()).generate({ ...ollamaParams, signal: controller.signal })
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("Claudeはメタデータ取得中の中止を伝播してmessages作成を始めない", async () => {
    const controller = new AbortController();
    const modelRequest = deferred<Response>();
    const modelStarted = deferred<void>();
    let modelSignal: AbortSignal | undefined;
    let modelCalls = 0;
    let messageCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) {
        modelCalls += 1;
        if (modelCalls > 1) {
          return Promise.resolve(jsonResponse(claudeModel));
        }
        modelSignal = init?.signal ?? undefined;
        modelStarted.resolve();
        return modelRequest.promise;
      }
      messageCalls += 1;
      return Promise.resolve(jsonResponse(claudeMessage("ok")));
    }));

    const provider = new ClaudeProvider(claudeContext());
    const request = provider.generate({
      ...ollamaParams,
      signal: controller.signal,
    });
    await modelStarted.promise;
    controller.abort();
    expect(modelSignal?.aborted).toBe(true);
    modelRequest.resolve(jsonResponse(claudeModel));

    await expect(request).rejects.toMatchObject({ kind: "aborted" });
    expect(messageCalls).toBe(0);
    await expect(provider.generate(ollamaParams)).resolves.toMatchObject({ text: "ok" });
    expect(modelCalls).toBe(2);
  });

  test("Claudeはrefusalをbad_responseとして返す", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) {
        return jsonResponse(claudeModel);
      }
      return jsonResponse(claudeMessage("", "refusal"));
    }));

    await expect(new ClaudeProvider(claudeContext()).generate(ollamaParams)).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  test("Claudeは空白だけの応答をbad_responseとして返す", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) {
        return jsonResponse(claudeModel);
      }
      return jsonResponse(claudeMessage(" \n\t "));
    }));

    await expect(new ClaudeProvider(claudeContext()).generate(ollamaParams)).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  test.each([
    ["nullの成功応答", null],
    ["contentが配列ではない成功応答", { ...claudeMessage("ok"), content: {} }],
    ["stop_reasonがない成功応答", { ...claudeMessage("ok"), stop_reason: undefined }],
    ["stop_reasonが未対応の成功応答", { ...claudeMessage("ok"), stop_reason: "unknown" }],
  ])("Claudeは%sをbad_responseとして返す", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.includes("/v1/models/") ? jsonResponse(claudeModel) : jsonResponse(body);
    }));

    await expect(new ClaudeProvider(claudeContext()).generate(ollamaParams)).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  test.each([
    ["空のJSON HTTP本文", ""],
    ["壊れたJSON HTTP本文", "{"],
  ])("Claudeは%sのSDKデコード失敗をbad_responseとして返す", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) {
        return jsonResponse(claudeModel);
      }
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    await expect(new ClaudeProvider(claudeContext()).generate(ollamaParams)).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  test.each([
    ["end_turn", claudeMessage("ok", "end_turn")],
    ["null", claudeMessage("ok", null)],
  ])("Claudeは有効なstop_reason %sを受け入れる", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.includes("/v1/models/") ? jsonResponse(claudeModel) : jsonResponse(body);
    }));

    await expect(new ClaudeProvider(claudeContext()).generate(ollamaParams)).resolves.toMatchObject({
      text: "ok",
    });
  });

  test("Claudeはthinking拒否時だけ1回だけ再試行する", async () => {
    let messageCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) {
        return jsonResponse(claudeModel);
      }
      messageCalls += 1;
      if (messageCalls === 1) {
        return jsonResponse(
          {
            type: "error",
            error: { type: "invalid_request_error", message: "thinking is unsupported" },
          },
          400
        );
      }
      return jsonResponse(claudeMessage("ok"));
    }));

    await expect(
      new ClaudeProvider(claudeContext()).generate({ ...ollamaParams, disableThinking: true })
    ).resolves.toMatchObject({ text: "ok" });
    expect(messageCalls).toBe(2);
  });

  test("Claudeはthinking以外の失敗を再試行しない", async () => {
    let messageCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) {
        return jsonResponse(claudeModel);
      }
      messageCalls += 1;
      return jsonResponse(
        {
          type: "error",
          error: { type: "api_error", message: "temporary failure" },
        },
        500
      );
    }));

    await expect(new ClaudeProvider(claudeContext()).generate(ollamaParams)).rejects.toMatchObject({
      kind: "bad_response",
    });
    expect(messageCalls).toBe(1);
  });

  test("400が続いても、外せる指定を試し終えたら打ち切る", async () => {
    // 拒否された指定を1つずつ外して再試行するが、無限には試さない。
    // 課金されるプロバイダーなので、諦める条件を明確にしておく。
    // このモデルは effort 非対応で、この呼び出しはJSONスキーマも渡していない。
    // **送っていない指定は外す候補にしない**（外しても意味がないうえ、
    // 「非対応」と覚えてしまうと、次に必要になったとき使えなくなる）
    let messageCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) {
        return jsonResponse(claudeModel);
      }
      messageCalls += 1;
      return jsonResponse(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "unsupported" },
        },
        400
      );
    }));

    await expect(
      new ClaudeProvider(claudeContext()).generate({ ...ollamaParams, disableThinking: true })
    ).rejects.toMatchObject({ kind: "bad_response" });
    // 初回 + 思考の無効化を外した1回だけ
    expect(messageCalls).toBe(2);
  });

  test("残高不足を要求の不備と取り違えない", async () => {
    // Anthropicは残高不足も400 invalid_request_error で返す。
    // 機能を外しても直らないうえ、外し続けると対応機能を失う
    let messageCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) {
        return jsonResponse(claudeModel);
      }
      messageCalls += 1;
      return jsonResponse(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
          },
        },
        400
      );
    }));

    await expect(
      new ClaudeProvider(claudeContext()).generate({
        ...ollamaParams,
        disableThinking: true,
      })
    ).rejects.toMatchObject({ kind: "insufficient_credit" });
    // 直らない再試行を繰り返さない
    expect(messageCalls).toBe(1);
  });

  test("失敗しただけでは対応状況を記憶しない", async () => {
    // 原因が残高不足でも、機能が未対応と覚えてしまうと
    // 支払ったあとも対応機能を使わなくなる
    const context = claudeContext();
    let failing = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) {
        return jsonResponse(claudeModel);
      }
      if (failing) {
        return jsonResponse(
          {
            type: "error",
            error: { type: "invalid_request_error", message: "unsupported" },
          },
          400
        );
      }
      return jsonResponse(claudeMessage("ok"));
    }));

    const provider = new ClaudeProvider(context);
    await expect(provider.generate(ollamaParams)).rejects.toMatchObject({
      kind: "bad_response",
    });

    // 状況が変わって通るようになったら、最初の組み合わせから試し直せる
    failing = false;
    await expect(
      new ClaudeProvider(context).generate(ollamaParams)
    ).resolves.toMatchObject({ text: "ok" });
  });

  test("拒否された理由を捨てずにログへ残せる形にする", async () => {
    // 以前はステータスだけを詳細にしており、原因にたどり着けなかった
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/models/")) {
        return jsonResponse(claudeModel);
      }
      return jsonResponse(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "output_config.format: unsupported keyword maxLength",
          },
        },
        400
      );
    }));

    await expect(
      new ClaudeProvider(claudeContext()).generate(ollamaParams)
    ).rejects.toMatchObject({
      kind: "bad_response",
      detail: expect.stringContaining("maxLength"),
    });
  });

  /**
   * プロンプトキャッシュが効いているかを測れるようにする第1段。
   *
   * **効かせる工夫より先に、読むほうを入れる。** 数字が残っていなければ、
   * あとで工夫をしても前後を比べられない（設計書6.27.7「まず測る」）。
   *
   * ここで確かめるのは**応答から拾えているか**だけで、キャッシュを
   * 効かせる指定（Claudeの `cache_control`）はまだ送っていない。
   */
  describe("プロンプトキャッシュの効きを読む", () => {
    function openAiChat(usage: Record<string, unknown>) {
      return {
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage,
      };
    }

    function geminiChat(usageMetadata: Record<string, unknown>) {
      return {
        candidates: [
          { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
        ],
        usageMetadata,
      };
    }

    test("OpenAI互換の cached_tokens を拾う", async () => {
      // さくらのAI・LM Studio も同じ形を読む（口がOpenAI互換のため）
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(
            openAiChat({
              prompt_tokens: 12_000,
              completion_tokens: 300,
              prompt_tokens_details: { cached_tokens: 9_600 },
            })
          )
        )
      );

      const result = await new OpenAIProvider(claudeContext()).generate(
        ollamaParams
      );

      expect(result.usage).toEqual({
        inputTokens: 12_000,
        outputTokens: 300,
        cachedInputTokens: 9_600,
      });
    });

    test("OpenAI互換で内訳が返らなければ undefined のままにする", async () => {
      // **0で埋めない。** 0は「対応しているが効かなかった」に取っておく
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(
            openAiChat({ prompt_tokens: 12_000, completion_tokens: 300 })
          )
        )
      );

      const result = await new OpenAIProvider(claudeContext()).generate(
        ollamaParams
      );

      expect(result.usage?.cachedInputTokens).toBeUndefined();
    });

    test("Geminiの cachedContentTokenCount を拾う", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(
            geminiChat({
              promptTokenCount: 12_000,
              candidatesTokenCount: 300,
              cachedContentTokenCount: 9_600,
            })
          )
        )
      );

      const result = await new GeminiProvider(claudeContext()).generate(
        ollamaParams
      );

      expect(result.usage).toEqual({
        inputTokens: 12_000,
        outputTokens: 300,
        cachedInputTokens: 9_600,
      });
    });

    test("Geminiが数を返さなければ undefined のままにする", async () => {
      // 効かなかった回は項目ごと返らない。0と書くと記録の意味が変わる
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(
            geminiChat({ promptTokenCount: 12_000, candidatesTokenCount: 300 })
          )
        )
      );

      const result = await new GeminiProvider(claudeContext()).generate(
        ollamaParams
      );

      expect(result.usage?.cachedInputTokens).toBeUndefined();
    });

    test("Claudeの cache_read_input_tokens を拾い、nullは undefined として扱う", async () => {
      // Anthropicはキャッシュを使っていない回に null を返すことがある。
      // そのまま渡すと、記録の欄に「対応しているのに効かなかった（0）」でも
      // 「数えられない（空欄）」でもないものが入る
      const withCache = {
        ...claudeMessage("ok"),
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: null,
        },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = input instanceof Request ? input.url : String(input);
          return url.includes("/v1/models/")
            ? jsonResponse(claudeModel)
            : jsonResponse(withCache);
        })
      );

      const result = await new ClaudeProvider(claudeContext()).generate(
        ollamaParams
      );

      expect(result.usage?.cachedInputTokens).toBe(8);
    });

    test("Claudeがキャッシュの数を返さない回は undefined のままにする", async () => {
      // いまは `cache_control` を送っていないので、これが通常の応答である
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = input instanceof Request ? input.url : String(input);
          return url.includes("/v1/models/")
            ? jsonResponse(claudeModel)
            : jsonResponse(claudeMessage("ok"));
        })
      );

      const result = await new ClaudeProvider(claudeContext()).generate(
        ollamaParams
      );

      expect(result.usage?.cachedInputTokens).toBeUndefined();
    });
  });

  /**
   * LM Studioのコンテキスト長を、設定値ではなくLM Studio自身から読む
   * （作者の報告、2026-08-27：「8kと表示されていますが、LM Studioから見ると
   * もう少し多そうです」）。
   *
   * 応答の形は、この機械のLM Studio 0.4.21を実際に叩いて写したもの。
   */
  describe("LM Studioのコンテキスト長", () => {
    const loadedModel = {
      id: "google/gemma-4-e4b",
      object: "model",
      type: "vlm",
      state: "loaded",
      max_context_length: 131072,
      loaded_context_length: 131072,
    };

    const notLoadedModel = {
      id: "google/gemma-4-12b-qat",
      object: "model",
      type: "vlm",
      state: "not-loaded",
      // 未読込には loaded_context_length が無い。**この値は使ってはいけない**
      max_context_length: 262144,
    };

    // **名前に embed を含めていない。** 名前で弾く既存の網を通り抜けさせて、
    // 種別（type）で外せているかを確かめるため
    const embeddingModel = {
      id: "nomic-ai/nomic-text-v1.5",
      object: "model",
      type: "embeddings",
      state: "not-loaded",
      max_context_length: 2048,
    };

    /**
     * LM Studioの2つの口を立てる。
     *
     * `native` に undefined を渡すと、`/api/v0/models` を持たない古い版に
     * なる（404）。`/v1/models` は種別も読み込み状況も返さない
     */
    function stubLmStudio(
      native: unknown[] | undefined,
      ids: string[]
    ): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/v0/models")) {
          return native === undefined
            ? jsonResponse({ error: "Unexpected endpoint" }, 404)
            : jsonResponse({ data: native });
        }
        return jsonResponse({
          data: ids.map((id) => ({ id, object: "model" })),
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    /** コンテキスト長の設定だけを差し替える（ほかは既定のまま） */
    function stubContextWindowSetting(value: number): void {
      workspace.getConfiguration = () => ({
        get: <T>(key: string, defaultValue: T): T =>
          key === "lmstudio.contextWindow" ? (value as T) : defaultValue,
      });
    }

    test("読み込み済みのモデルは、LM Studioが読み込んだ長さを使う", async () => {
      stubContextWindowSetting(8192);
      stubLmStudio([loadedModel], [loadedModel.id]);

      const provider = new LmStudioProvider();
      const models = await provider.listModels();

      expect(models).toHaveLength(1);
      // 設定値（8192）ではなく、実際に読み込んだ 131072 が出る
      expect(models[0].contextWindow).toBe(131072);

      // 一覧を引いたあと（キャッシュ経由）でも設定値へ戻らない。
      // ここが戻ると、モデル選択だけ正しく見えて実際の送信量は8kになる
      expect((await provider.getModel(loadedModel.id))?.contextWindow).toBe(
        131072
      );
    });

    test("未読込のモデルは設定値のまま（max_context_lengthを使わない）", async () => {
      // **実際より大きい想定は、入力が黙って切り捨てられるということ。**
      // 262144 は「対応できる最大」であって、読み込むときに何を指定されるかは
      // こちらからは分からない
      stubContextWindowSetting(32768);
      stubLmStudio([notLoadedModel], [notLoadedModel.id]);

      const provider = new LmStudioProvider();
      const models = await provider.listModels();

      expect(models[0].contextWindow).toBe(32768);
      expect(models[0].contextWindow).not.toBe(262144);
      expect((await provider.getModel(notLoadedModel.id))?.contextWindow).toBe(
        32768
      );
    });

    test("/api/v0/models が無い版でも、従来どおり設定値で動く", async () => {
      // 古いLM Studioにはこの口が無い。**読めなくても悪くならない**ことを、
      // 一覧が空にならない・例外にならないところまで確かめる
      stubContextWindowSetting(16384);
      stubLmStudio(undefined, ["some-model-7b"]);

      const provider = new LmStudioProvider();
      const models = await provider.listModels();

      expect(models.map((m) => m.id)).toEqual(["some-model-7b"]);
      expect(models[0].contextWindow).toBe(16384);
      expect((await provider.getModel("some-model-7b"))?.contextWindow).toBe(
        16384
      );
      // 導入案内の初期値も、取れないときは黙って undefined を返す
      expect(await provider.readLoadedContextWindow()).toBeUndefined();
    });

    test("種別が embeddings のモデルは一覧から外す", async () => {
      stubLmStudio(
        [loadedModel, embeddingModel],
        [loadedModel.id, embeddingModel.id]
      );

      const models = await new LmStudioProvider().listModels();

      expect(models.map((m) => m.id)).toEqual([loadedModel.id]);
    });

    test("読み込み状況と対応できる最大を、そのまま読み取れる", async () => {
      // 拡張機能がモデルを読み込む（`lmstudioModelLoad.ts`）ために要る。
      // 未読込かどうかと、どこまで指定できるかが分からないと決められない
      stubLmStudio(
        [loadedModel, notLoadedModel],
        [loadedModel.id, notLoadedModel.id]
      );
      const provider = new LmStudioProvider();

      expect(await provider.readModelLoadState(loadedModel.id)).toEqual({
        loaded: true,
        maxContextLength: 131072,
        loadedContextLength: 131072,
      });
      expect(await provider.readModelLoadState(notLoadedModel.id)).toEqual({
        loaded: false,
        maxContextLength: 262144,
        // 未読込には無い。**ここを埋めると、載ってもいない長さを実測と誤る**
        loadedContextLength: undefined,
      });
    });

    test("知らないモデルと、口の無い版では読み込み状況を返さない", async () => {
      // 分からないまま読み込ませない（JITに任せる）
      stubLmStudio([loadedModel], [loadedModel.id]);
      expect(
        await new LmStudioProvider().readModelLoadState("no/such-model")
      ).toBeUndefined();

      stubLmStudio(undefined, [loadedModel.id]);
      expect(
        await new LmStudioProvider().readModelLoadState(loadedModel.id)
      ).toBeUndefined();
    });

    test("一覧には、対応できる最大と読み込み状況を添える", async () => {
      // 表示を分けるために使う（`contextWindow` は分割に使う値なので変えない）
      stubContextWindowSetting(8192);
      stubLmStudio([notLoadedModel], [notLoadedModel.id]);

      const models = await new LmStudioProvider().listModels();

      expect(models[0].loaded).toBe(false);
      expect(models[0].maxContextWindow).toBe(262144);
      // 分割に使う値は、これまでどおり設定値のまま
      expect(models[0].contextWindow).toBe(8192);
    });

    test("読み込み状況が取れない版では、未読込と断じない", async () => {
      stubLmStudio(undefined, ["some-model-7b"]);

      const models = await new LmStudioProvider().listModels();

      expect(models[0].loaded).toBeUndefined();
      expect(models[0].maxContextWindow).toBeUndefined();
    });

    test("導入案内の初期値には、読み込み済みのうち短いほうを返す", async () => {
      // 設定値は全モデル共通の予備なので、長いほうに合わせると
      // 短いモデルを選んだときに入力が切り捨てられる
      const shorter = {
        ...notLoadedModel,
        state: "loaded",
        loaded_context_length: 8192,
      };
      stubLmStudio([loadedModel, shorter], [loadedModel.id, shorter.id]);

      expect(await new LmStudioProvider().readLoadedContextWindow()).toBe(8192);
    });
  });

  /**
   * モデルを読み込めなかったとき、LM Studioが言った理由をそのまま届ける
   * （作者の依頼、2026-08-29）。
   *
   * これまではHTTP 400を `bad_response` に丸めており、通知は
   * 「出力上限とモデル設定を確認してください」という**見当外れの案内**に
   * なっていた。実際の原因はメモリ不足で、それはLM Studio自身が
   * 具体的に言っている。
   */
  describe("LM Studioのモデル読み込み失敗", () => {
    /** この機械で `google/gemma-4-12b-qat` を要求して実際に返った本文（2026-08-29） */
    const loadFailureBody = {
      error: {
        message:
          'Failed to load model "google/gemma-4-12b-qat". Error: Model loading was stopped due to insufficient system resources. Under the current settings, this model requires approximately 44.87 GB of memory, and continuing to load it would likely overload your system and cause it to freeze. If you think this is incorrect, you can adjust the model loading guardrails in settings.',
        type: "invalid_request_error",
        param: "model",
        code: null,
      },
    };

    const params = {
      systemPrompt: "system",
      userPrompt: "user",
      model: "google/gemma-4-12b-qat",
      temperature: 0.2,
    };

    test("読み込み失敗は専用の種別にし、理由をそのまま伝える", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(loadFailureBody, 400));
      vi.stubGlobal("fetch", fetchMock);

      const error = await new LmStudioProvider()
        .generate(params)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AIError);
      const aiError = error as AIError;
      expect(aiError.kind).toBe("model_load_failed");
      // どのモデルで起きたのかが分からないと、選び直しようがない
      expect(aiError.message).toContain("google/gemma-4-12b-qat");
      expect(aiError.message).toContain("メモリ不足");
      // LM Studioの説明（必要なメモリ量）を捨てない
      expect(aiError.message).toContain("44.87 GB");
      expect(aiError.detail).toContain("Failed to load model");

      // 指定を外して出し直しても同じところで落ちる。1回で打ち切る
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("読み込み失敗でない400は、これまでどおり扱う", async () => {
      // 何でも「モデルが載らない」と言い出さないことの確認
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({ error: { message: "Invalid 'messages'." } }, 400)
        )
      );

      const error = await new LmStudioProvider()
        .generate(params)
        .catch((e: unknown) => e);

      expect((error as AIError).kind).toBe("bad_response");
    });
  });
});
