import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import {
  ClaudeProvider,
  toClaudeAIError,
  toClaudeJsonSchema,
} from "../../src/ai/claudeProvider";
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
});
