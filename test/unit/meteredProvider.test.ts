import { beforeEach, describe, expect, test, vi } from "vitest";
import type { UsageLogEntry } from "../../src/core/usageLog";

/**
 * 記録の中身を確かめたいので、書き込みだけ差し替える。
 * 実物は `vscode.workspace.fs` を触るため、単体試験では動かせない。
 */
const appended: Array<{ workFolder: string; entry: UsageLogEntry }> = [];
vi.mock("../../src/core/usageLog", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/core/usageLog")>();
  return {
    ...actual,
    appendUsageLog: (workFolder: string, entry: UsageLogEntry) => {
      appended.push({ workFolder, entry });
    },
  };
});

const { MeteredProvider } = await import("../../src/ai/meteredProvider");
const { AIError } = await import("../../src/ai/types");
import type {
  AIProvider,
  GenerateParams,
  GenerateResult,
  ModelInfo,
} from "../../src/ai/types";

function fakeProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    id: "ollama",
    displayName: "Ollama（ローカル）",
    isPaid: false,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate: async (): Promise<GenerateResult> => ({
      text: "{}",
      truncated: false,
      elapsedMs: 1_200,
      usage: { inputTokens: 12_000, outputTokens: 300 },
    }),
    ...overrides,
  };
}

function params(overrides: Partial<GenerateParams> = {}): GenerateParams {
  return {
    systemPrompt: "あ".repeat(200),
    userPrompt: "い".repeat(8_000),
    model: "gemma4:e4b",
    temperature: 0,
    ...overrides,
  };
}

beforeEach(() => {
  appended.length = 0;
});

describe("送信量を記録する包み", () => {
  test("機能名と作品が分かる呼び出しを記録する", async () => {
    const provider = new MeteredProvider(fakeProvider());

    await provider.generate(
      params({ meta: { feature: "typo_check", workFolder: "C:/works/小説" } })
    );

    expect(appended).toHaveLength(1);
    expect(appended[0].workFolder).toBe("C:/works/小説");
    expect(appended[0].entry.feature).toBe("typo_check");
    expect(appended[0].entry.systemChars).toBe(200);
    expect(appended[0].entry.userChars).toBe(8_000);
  });

  test("スキーマはJSONにしたときの字数で数える", async () => {
    const provider = new MeteredProvider(fakeProvider());

    await provider.generate(
      params({
        jsonSchema: { type: "object" },
        meta: { feature: "typo_check", workFolder: "C:/works/小説" },
      })
    );

    expect(appended[0].entry.schemaChars).toBe(
      JSON.stringify({ type: "object" }).length
    );
  });

  test("トークン数と所要時間を残す", async () => {
    const provider = new MeteredProvider(fakeProvider());

    await provider.generate(
      params({ meta: { feature: "typo_check", workFolder: "C:/works/小説" } })
    );

    expect(appended[0].entry.usage).toEqual({
      inputTokens: 12_000,
      outputTokens: 300,
    });
    expect(appended[0].entry.elapsedMs).toBe(1_200);
  });

  test("meta が無い呼び出しは記録しない", async () => {
    // 作品に属さない呼び出し（接続確認など）を、どこかの作品の
    // ログへ書くとその作品の数字が狂う
    const provider = new MeteredProvider(fakeProvider());

    await provider.generate(params());

    expect(appended).toHaveLength(0);
  });

  test("作品フォルダーが分からない呼び出しは記録しない", async () => {
    const provider = new MeteredProvider(fakeProvider());

    await provider.generate(params({ meta: { feature: "work_chat" } }));

    expect(appended).toHaveLength(0);
  });

  test("失敗しても記録してから、そのまま投げ直す", async () => {
    // うまくいった回だけ残すと、答えが返らなかった理由を追えない
    const provider = new MeteredProvider(
      fakeProvider({
        generate: async () => {
          throw new AIError("残高がありません", "insufficient_credit");
        },
      })
    );

    await expect(
      provider.generate(
        params({ meta: { feature: "typo_check", workFolder: "C:/works/小説" } })
      )
    ).rejects.toThrow("残高がありません");

    expect(appended).toHaveLength(1);
    expect(appended[0].entry.error).toBe(
      "insufficient_credit: 残高がありません"
    );
  });

  test("応答が返っただけで、送った量は記録される", async () => {
    // 切り詰められた回こそ、送りすぎていた証拠になる
    const provider = new MeteredProvider(
      fakeProvider({
        generate: async () => ({ text: "", truncated: true, elapsedMs: 90 }),
      })
    );

    await provider.generate(
      params({
        numCtx: 16_384,
        meta: { feature: "character_extract", workFolder: "C:/works/小説" },
      })
    );

    expect(appended[0].entry.truncated).toBe(true);
    expect(appended[0].entry.numCtx).toBe(16_384);
  });
});

describe("包んでも元のプロバイダと同じに見える", () => {
  test("名前と料金の別を、そのまま通す", () => {
    const provider = new MeteredProvider(
      fakeProvider({ id: "claude", displayName: "Claude", isPaid: true })
    );

    expect(provider.id).toBe("claude");
    expect(provider.displayName).toBe("Claude");
    expect(provider.isPaid).toBe(true);
  });

  test("getModel を持たないプロバイダには生やさない", () => {
    // 「持っているかどうか」で呼び出し側が分岐する（resolveModelInfo）。
    // 生やすと、一覧から探す道が使われなくなってモデル情報が取れない
    const provider = new MeteredProvider(fakeProvider());

    expect(provider.getModel).toBeUndefined();
  });

  test("getModel を持つプロバイダでは、そのまま呼ぶ", async () => {
    const info: ModelInfo = {
      id: "gemma4:e4b",
      displayName: "gemma4:e4b",
      contextWindow: 131_072,
      parameterSize: "8.0B",
      capabilities: [],
      tier: "standard",
    };
    const provider = new MeteredProvider(
      fakeProvider({ getModel: async () => info })
    );

    expect(await provider.getModel?.("gemma4:e4b")).toBe(info);
  });

  test("接続確認とモデル一覧も、そのまま通す", async () => {
    const provider = new MeteredProvider(
      fakeProvider({
        testConnection: async () => ({ ok: false, message: "起動していません" }),
      })
    );

    expect((await provider.testConnection()).message).toBe("起動していません");
    expect(await provider.listModels()).toEqual([]);
  });
});
