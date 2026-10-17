import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "../support/sweepTimeout";
import type { ExtensionContext } from "vscode";
import { OllamaProvider } from "../../../src/ai/ollamaProvider";
import { ClaudeProvider } from "../../../src/ai/claudeProvider";
import { OpenAIProvider } from "../../../src/ai/openaiProvider";
import { GeminiProvider } from "../../../src/ai/geminiProvider";
import { LmStudioProvider } from "../../../src/ai/lmstudioProvider";
import { SakuraProvider } from "../../../src/ai/sakuraProvider";
import { AIError, type GenerateParams } from "../../../src/ai/types";
import {
  IMAGE_SUPPORT_UNKNOWN_NOTE,
  canSendImages,
  imageSupportFor,
} from "../../../src/ai/imageInput";
import { imageNoteFor } from "../../../src/ai/registry";
import { setStreamingSettingReader } from "../../../src/ai/ollamaStream";
import { workspace } from "../support/vscodeStub";
import { jsonResponse } from "../support/aiResponses";

/**
 * 写真（画像）をAIへ渡す形と、写真を読めるかの判定（設計書6.117.4）。
 *
 * **送る形はプロバイダごとに違う。** ここで固定しておかないと、片方を直した
 * ときに別のプロバイダで写真が黙って落ち、写真を見ないまま作文が返る。
 */

const IMAGE = { mimeType: "image/jpeg", base64: "QUJD" };

const params: GenerateParams = {
  systemPrompt: "system",
  userPrompt: "書き起こしてください",
  images: [IMAGE],
  model: "test-model",
  temperature: 0,
  numCtx: 8192,
};

function context(): ExtensionContext {
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

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

describe("写真を送る形", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
    // 流して受け取る道を切り、まとめて受け取る道で送った中身を見る
    setStreamingSettingReader(() => false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setStreamingSettingReader(undefined);
  });

  test("Ollama：利用者の発言の images に、頭の無い base64 を並べる", async () => {
    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ message: { content: '{"lines":[]}' }, done_reason: "stop" });
      })
    );
    await new OllamaProvider().generate(params);
    const messages = sent?.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: "user",
      content: "書き起こしてください",
      images: ["QUJD"],
    });
    // 写真の分は文字数の見積もりに入らないので、呼ぶ側の num_ctx をそのまま送る
    expect((sent?.options as Record<string, unknown>).num_ctx).toBe(8192);
  });

  test("Ollama：写真が無ければ、これまでどおり images を付けない", async () => {
    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ message: { content: "ok" }, done_reason: "stop" });
      })
    );
    await new OllamaProvider().generate({ ...params, images: undefined });
    const messages = sent?.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({ role: "user", content: "書き起こしてください" });
  });

  test("Claude：写真を文より前に、base64 の image として並べる", async () => {
    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = urlOf(input);
        if (url.includes("/v1/messages")) {
          sent = JSON.parse(String(init?.body));
          return jsonResponse({
            id: "msg",
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [{ type: "text", text: '{"lines":[]}' }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }
        return jsonResponse({
          id: "test-model",
          display_name: "Test",
          max_input_tokens: 200000,
          max_tokens: 8192,
          capabilities: { image_input: { supported: true } },
        });
      })
    );
    await new ClaudeProvider(context()).generate(params);
    const messages = sent?.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
      { type: "text", text: "書き起こしてください" },
    ]);
  });

  test("Gemini：写真を inlineData として文より前に並べる", async () => {
    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: '{"lines":[]}' }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        });
      })
    );
    await new GeminiProvider(context()).generate(params);
    const contents = sent?.contents as Array<{ parts: unknown }>;
    expect(contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/jpeg", data: "QUJD" } },
      { text: "書き起こしてください" },
    ]);
  });

  test.each([
    ["ChatGPT", () => new OpenAIProvider(context())],
    ["LM Studio", () => new LmStudioProvider()],
  ])("%s：OpenAI互換の image_url（data: の頭つき）で並べる", async (_name, make) => {
    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/chat/completions")) {
          sent = JSON.parse(String(init?.body));
          return jsonResponse({
            choices: [{ message: { content: '{"lines":[]}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          });
        }
        return jsonResponse({ data: [] });
      })
    );
    await make().generate(params);
    const messages = sent?.messages as Array<{ role: string; content: unknown }>;
    expect(messages[1].content).toEqual([
      { type: "text", text: "書き起こしてください" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    ]);
  });

  test("さくらのAI：写真を黙って捨てずに、送る前に断る", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const error = await new SakuraProvider(context()).generate(params).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).message).toContain("写真を送れません");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("写真を読めるかの判定（名前で決めない）", () => {
  test("申告を返す3つは、申告に従う", () => {
    for (const id of ["ollama", "lmstudio", "claude"] as const) {
      expect(imageSupportFor(id, { imageInput: true }).kind).toBe("yes");
      expect(imageSupportFor(id, { imageInput: false }).kind).toBe("no");
      // 申告が無いのは「分からない」。「読めない」へ丸めない
      expect(imageSupportFor(id, {}).kind).toBe("unknown");
      expect(imageSupportFor(id).kind).toBe("unknown");
    }
  });

  test("申告の無い Gemini・ChatGPT は「分からない」（選べる）", () => {
    for (const id of ["gemini", "openai"] as const) {
      const support = imageSupportFor(id, { imageInput: undefined });
      expect(support).toEqual({ kind: "unknown", note: IMAGE_SUPPORT_UNKNOWN_NOTE });
      expect(canSendImages(support)).toBe(true);
    }
  });

  test("写真を送る口の無いさくらのAI・VS Code 経由は、理由つきで選べない", () => {
    for (const id of ["sakura", "vscode-lm"] as const) {
      const support = imageSupportFor(id, { imageInput: true });
      expect(support.kind).toBe("no");
      expect(canSendImages(support)).toBe(false);
      if (support.kind === "no") expect(support.reason.length).toBeGreaterThan(0);
    }
  });

  test("選ぶ画面の行：読めないもの・分からないものにだけ印を添える", () => {
    expect(imageNoteFor(undefined, "速さ 20字/秒")).toBe("速さ 20字/秒");
    expect(imageNoteFor({ kind: "yes" }, "速さ 20字/秒")).toBe("速さ 20字/秒");
    expect(imageNoteFor({ kind: "no", reason: "理由" }, undefined)).toBe(
      "$(circle-slash) 写真を送れません：理由"
    );
    expect(
      imageNoteFor({ kind: "unknown", note: IMAGE_SUPPORT_UNKNOWN_NOTE }, "速さ")
    ).toBe(`$(question) ${IMAGE_SUPPORT_UNKNOWN_NOTE}　速さ`);
  });
});

describe("モデルの申告を読む", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  test("Ollama：capabilities に vision があれば読める、無ければ読めない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        return jsonResponse({
          model_info: { "general.architecture": "gemma", "gemma.context_length": 8192 },
          details: { parameter_size: "26B" },
          capabilities: body.model === "eye" ? ["completion", "vision"] : ["completion"],
        });
      })
    );
    const provider = new OllamaProvider();
    expect((await provider.getModel("eye"))?.imageInput).toBe(true);
    expect((await provider.getModel("text"))?.imageInput).toBe(false);
  });

  test("LM Studio：種別が vlm なら読める、llm なら読めない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: "eye", type: "vlm", state: "loaded", loaded_context_length: 8192 },
            { id: "text", type: "llm", state: "loaded", loaded_context_length: 8192 },
          ],
        })
      )
    );
    const provider = new LmStudioProvider();
    expect((await provider.getModel("eye"))?.imageInput).toBe(true);
    expect((await provider.getModel("text"))?.imageInput).toBe(false);
  });
});
