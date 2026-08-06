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

function claudeMessage(content: string, stopReason: "end_turn" | "refusal" = "end_turn") {
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
    [
      new Anthropic.AuthenticationError(401, {}, "invalid API key", new Headers()),
      "not_running",
    ],
    [
      new Anthropic.PermissionDeniedError(403, {}, "permission denied", new Headers()),
      "bad_response",
    ],
    [
      new Anthropic.RateLimitError(429, {}, "rate limited", new Headers()),
      "bad_response",
    ],
    [new Anthropic.APIConnectionTimeoutError(), "timeout"],
    [new Anthropic.APIUserAbortError(), "aborted"],
  ])("Claude SDKエラーを%sとして正規化する", (error, kind) => {
    expect(toClaudeAIError(error)).toMatchObject({ kind });
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
});
