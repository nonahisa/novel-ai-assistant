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
const { resetAiSequence, acquireRun } = await import(
  "../../src/core/aiSequence"
);
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
  resetAiSequence();
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

describe("リクエストの関所（設計書6.76）", () => {
  /**
   * 実際に送っている最中かどうかを見張る作り物。
   *
   * **重なったら、その場で印を残す。** あとから所要時間を眺めても
   * 「重なっていたのか、たまたま速かったのか」は分からない。
   */
  function watchfulProvider(): {
    provider: AIProvider;
    overlapped: () => boolean;
    order: string[];
  } {
    let inFlight = 0;
    let overlapped = false;
    const order: string[] = [];
    return {
      overlapped: () => overlapped,
      order,
      provider: fakeProvider({
        generate: async (p: GenerateParams): Promise<GenerateResult> => {
          inFlight++;
          if (inFlight > 1) overlapped = true;
          order.push(`開始:${p.model}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`終了:${p.model}`);
          inFlight--;
          return { text: "{}", truncated: false, elapsedMs: 1 };
        },
      }),
    };
  }

  test("2つを同時に呼んでも、実送信は重ならない", async () => {
    const watch = watchfulProvider();
    const provider = new MeteredProvider(watch.provider);

    await Promise.all([
      provider.generate(params({ model: "あ" })),
      provider.generate(params({ model: "い" })),
    ]);

    expect(watch.overlapped()).toBe(false);
    expect(watch.order).toEqual(["開始:あ", "終了:あ", "開始:い", "終了:い"]);
  });

  test("順番待ちの最中に中止されたら、そもそも送らない", async () => {
    let sent = 0;
    const provider = new MeteredProvider(
      fakeProvider({
        generate: async (): Promise<GenerateResult> => {
          sent++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { text: "{}", truncated: false, elapsedMs: 1 };
        },
      })
    );

    const controller = new AbortController();
    const first = provider.generate(params({ model: "先客" }));
    const second = provider.generate(
      params({ model: "待ち", signal: controller.signal })
    );
    // 先客が送っている間に取りやめる
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();

    await expect(second).rejects.toMatchObject({ kind: "aborted" });
    await first;

    expect(sent).toBe(1);
  });

  test("札を持っている機能も、関所は普通に通れる", async () => {
    // デッドロックの禁止則（札 → 関所の一方向）が守られていることの裏取り。
    // 札を持ったまま送れないと、一括処理が1件目で止まる
    const release = await acquireRun("誤字脱字検知");
    const provider = new MeteredProvider(fakeProvider());

    await expect(provider.generate(params())).resolves.toMatchObject({
      text: "{}",
    });

    release();
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

  test("「上限を掛けない」という印も、そのまま通す", () => {
    // 関所がこれを見て見込みと実上限を選ぶ（設計書6.77の第2段）。
    // 包みが落とすと、Ollamaが上限を掛ける側として扱われる
    const provider = new MeteredProvider(fakeProvider({ capsOutput: false }));

    expect(provider.capsOutput).toBe(false);
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
