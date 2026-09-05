import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AIProvider,
  GenerateParams,
  GenerateResult,
} from "../../src/ai/types";

/**
 * 一括機能どうしを同時に起動したときの流れ（設計書6.76）。
 *
 * **確かめたいのは順番である。** リクエストの関所（同時1件）だけだと
 * 誤字1・矛盾1・誤字2・矛盾2… と交互に流れ、Ollamaでは機能ごとに
 * `num_ctx` もモデルも違うので、そのたびに読み込み直しが往復する。
 * 実行の札を取ると、先客が全部終わってから後客が始まる。
 *
 * 本物の `checkTypos` / `checkContradictions` は作品フォルダーも設定資料も
 * 要るので、ここでは**その2つと同じ形**——`withAiTurnProgress` で包んだ
 * チャンクのループが、`MeteredProvider` 越しにAIを呼ぶ——を組んで測る。
 * 機能側に札が入っているかどうかは `aiTurnWiring.test.ts` が見張る。
 */

vi.mock("../../src/core/usageLog", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/core/usageLog")>();
  return { ...actual, appendUsageLog: () => undefined };
});

/** `views/progress` の代役。中止はしないので、素通しでよい */
vi.mock("../../src/views/progress", () => ({
  withCancellableProgress: async (
    _title: string,
    task: (
      progress: { report: (value: { message?: string }) => void },
      token: {
        isCancellationRequested: boolean;
        onCancellationRequested: (listener: () => void) => { dispose(): void };
      }
    ) => Promise<unknown>
  ) =>
    task(
      { report: () => undefined },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      }
    ),
}));

const { MeteredProvider } = await import("../../src/ai/meteredProvider");
const { withAiTurnProgress } = await import("../../src/features/aiTurn");
const { resetAiSequence } = await import("../../src/core/aiSequence");

/** 送られた順番を書き留めるAI。1回あたり少しだけ間を置く */
function recordingProvider(sent: string[]): AIProvider {
  return {
    id: "ollama",
    displayName: "Ollama（ローカル）",
    isPaid: false,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate: async (params: GenerateParams): Promise<GenerateResult> => {
      sent.push(params.userPrompt);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { text: "{}", truncated: false, elapsedMs: 1 };
    },
  };
}

/** 一括機能ひとつぶん（チャンクを順に送る） */
function runBulkFeature(
  provider: AIProvider,
  label: string,
  prefix: string,
  chunks: number
): Promise<void> {
  return withAiTurnProgress(`${label}しています`, { label }, async () => {
    for (let i = 1; i <= chunks; i++) {
      await provider.generate({
        systemPrompt: "",
        userPrompt: `${prefix}${i}`,
        model: prefix,
        temperature: 0,
      });
    }
  });
}

beforeEach(() => {
  resetAiSequence();
});

describe("一括機能を2つ同時に起動する", () => {
  test("交互にならず、先客が全部終わってから後客が始まる", async () => {
    const sent: string[] = [];
    const provider = new MeteredProvider(recordingProvider(sent));

    await Promise.all([
      runBulkFeature(provider, "誤字脱字の検知", "誤字", 3),
      runBulkFeature(provider, "矛盾の検知", "矛盾", 3),
    ]);

    expect(sent).toEqual(["誤字1", "誤字2", "誤字3", "矛盾1", "矛盾2", "矛盾3"]);
  });

  test("札を取らない単発の呼び出しは、チャンクの合間に入れる", async () => {
    // 相談・独り言・表記ゆれの1問がこれにあたる。10分の一括処理が
    // 終わるまで相談が1言も返せない、を避けるための決めごと（設計書6.76）
    const sent: string[] = [];
    const provider = new MeteredProvider(recordingProvider(sent));

    const bulk = runBulkFeature(provider, "誤字脱字の検知", "誤字", 3);
    // 1件目が送られている最中に、単発を割り込ませる
    await new Promise((resolve) => setTimeout(resolve, 1));
    const single = provider.generate({
      systemPrompt: "",
      userPrompt: "相談",
      model: "chat",
      temperature: 0,
    });

    await Promise.all([bulk, single]);

    expect(sent).toContain("相談");
    // **最後ではない。** 一括処理が全部終わるのを待たされていない
    expect(sent[sent.length - 1]).not.toBe("相談");
    expect(sent.indexOf("相談")).toBeLessThan(sent.indexOf("誤字3"));
  });
});
