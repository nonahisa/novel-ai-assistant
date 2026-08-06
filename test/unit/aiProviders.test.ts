import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import { toClaudeJsonSchema } from "../../src/ai/claudeProvider";
import { workspace } from "./support/vscodeStub";

describe("AIプロバイダ境界", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  afterEach(() => {
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
});
