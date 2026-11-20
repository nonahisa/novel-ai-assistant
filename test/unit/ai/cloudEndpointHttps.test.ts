import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "../support/vscodeStub";
import { GeminiProvider } from "../../../src/ai/geminiProvider";
import { OpenAIProvider } from "../../../src/ai/openaiProvider";
import { SakuraProvider } from "../../../src/ai/sakuraProvider";
import { AIError, type GenerateParams } from "../../../src/ai/types";
import { insecureCloudEndpointReason } from "../../../src/core/endpointNotice";

/**
 * クラウドのAIは https の宛先にしか送らない（セキュリティ点検 2026-11-21）。
 *
 * 宛先の設定（`novelai.*.endpoint`）は `machine` で作品フォルダーからは書けないが（設計書6.78の1）、
 * 作者が書き間違えた・古い手順を写した `http://` でも、そのまま鍵（ヘッダー）と本文を平文で流していた。
 * **この PC の中（localhost・127.0.0.1・::1）だけは http を通す**——OpenAI 互換の手元のサーバーを
 * ChatGPT の宛先に書く使い方があり、PC の外へは出ないため。
 */

describe("宛先の判定（insecureCloudEndpointReason）", () => {
  test("https は通す", () => {
    expect(insecureCloudEndpointReason("https://api.openai.com/v1")).toBeUndefined();
  });

  test("この PC の中の http は通す", () => {
    expect(insecureCloudEndpointReason("http://localhost:8080/v1")).toBeUndefined();
    expect(insecureCloudEndpointReason("http://127.0.0.1:1234/v1")).toBeUndefined();
    expect(insecureCloudEndpointReason("http://[::1]:1234/v1")).toBeUndefined();
  });

  test("外の http・ほかの方式・URL として読めないものは断る", () => {
    expect(insecureCloudEndpointReason("http://api.openai.com/v1")).toContain("https");
    expect(insecureCloudEndpointReason("http://192.168.1.20:8080/v1")).toContain("https");
    expect(insecureCloudEndpointReason("http://localhost.evil.example/v1")).toContain("https");
    expect(insecureCloudEndpointReason("ftp://example.com")).toContain("https");
    expect(insecureCloudEndpointReason("api.openai.com/v1")).toBeDefined();
  });
});

function fakeContext(): never {
  return {
    secrets: {
      get: async () => "test-api-key-0123456789",
      store: async () => undefined,
      delete: async () => undefined,
    },
    // 指定を外して通った組み合わせの覚え。**断ったときに書かれないこと**も下で見る
    globalState: {
      get: () => undefined,
      update: async () => {
        throw new Error("断った失敗から覚えを書いてはいけない");
      },
      keys: () => [],
    },
  } as never;
}

describe("クラウドのAIは、外の http の宛先へ鍵も本文も送らない", () => {
  const original = workspace.getConfiguration;
  const fetched: string[] = [];

  beforeEach(() => {
    fetched.length = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    workspace.getConfiguration = (() => ({
      get: <T>(key: string, defaultValue: T): T =>
        (key.endsWith(".endpoint") ? "http://ai.example.com/v1" : defaultValue) as T,
      inspect: () => undefined,
    })) as unknown as typeof workspace.getConfiguration;
  });
  afterEach(() => {
    workspace.getConfiguration = original;
    vi.unstubAllGlobals();
  });

  test.each([
    ["Gemini", () => new GeminiProvider(fakeContext())],
    ["ChatGPT", () => new OpenAIProvider(fakeContext())],
    ["さくら", () => new SakuraProvider(fakeContext())],
  ])("%s：接続の確認は通じないと返し、何も送らない", async (_name, make) => {
    const result = await make().testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("https");
    expect(fetched).toEqual([]);
  });

  test.each([
    ["Gemini", () => new GeminiProvider(fakeContext())],
    ["ChatGPT", () => new OpenAIProvider(fakeContext())],
    ["さくら", () => new SakuraProvider(fakeContext())],
  ])("%s：モデルの一覧も送らずに断る", async (_name, make) => {
    await expect(make().listModels()).rejects.toBeInstanceOf(AIError);
    expect(fetched).toEqual([]);
  });

  test.each([
    ["Gemini", () => new GeminiProvider(fakeContext()), "gemini-2.5-flash"],
    ["ChatGPT", () => new OpenAIProvider(fakeContext()), "gpt-4o-mini"],
    ["さくら", () => new SakuraProvider(fakeContext()), "preview/gemma-4-31B-it"],
  ])("%s：生成も本文を送らずに、https の理由で断る（指定を外して試し直さない）", async (_name, make, model) => {
    const params: GenerateParams = { systemPrompt: "指示", userPrompt: "本文", model, temperature: 0 };
    const failure = await make()
      .generate(params)
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(AIError);
    expect((failure as AIError).message).toContain("https");
    expect(fetched).toEqual([]);
  });
});
