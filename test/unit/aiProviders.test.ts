import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { ExtensionContext } from "vscode";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import {
  ClaudeProvider,
  toClaudeAIError,
  toClaudeJsonSchema,
} from "../../src/ai/claudeProvider";
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
  return {
    secrets: {
      get: async () => "test-api-key",
      store: async () => undefined,
      delete: async () => undefined,
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
        },
      },
      additionalProperties: false,
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

  test.each([
    [
      new Anthropic.AuthenticationError(401, {}, "invalid API key", new Headers()),
      "authentication_failed",
    ],
    [
      new Anthropic.PermissionDeniedError(403, {}, "permission denied", new Headers()),
      "permission_denied",
    ],
    [
      new Anthropic.RateLimitError(429, {}, "rate limited", new Headers()),
      "rate_limited",
    ],
    [new Anthropic.APIConnectionTimeoutError(), "timeout"],
    [new Anthropic.APIUserAbortError(), "aborted"],
  ])("Claude SDKエラーを%sとして正規化する", (error, kind) => {
    expect(toClaudeAIError(error)).toMatchObject({ kind });
  });

  test("Claudeの未知SDKエラーを安全な公開メッセージへ正規化する", () => {
    const rawMessage = "gateway returned credential=secret-value";

    expect(toClaudeAIError(new Error(rawMessage))).toMatchObject({ kind: "unknown" });
    expect(toClaudeAIError(new Error(rawMessage)).message).not.toContain(rawMessage);
  });

  test("Claudeの汎用SyntaxErrorはresponseデコード失敗としては正規化しない", () => {
    expect(toClaudeAIError(new SyntaxError("local programmer error"))).toMatchObject({
      kind: "unknown",
    });
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

  test("Claudeはthinking再試行の2回目が失敗したらそれ以上再試行しない", async () => {
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
          error: { type: "invalid_request_error", message: "thinking is unsupported" },
        },
        400
      );
    }));

    await expect(
      new ClaudeProvider(claudeContext()).generate({ ...ollamaParams, disableThinking: true })
    ).rejects.toMatchObject({ kind: "bad_response" });
    expect(messageCalls).toBe(2);
  });
});
