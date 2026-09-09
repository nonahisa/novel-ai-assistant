import { beforeEach, describe, expect, test } from "vitest";
import { requestChatterComment } from "../../src/features/chatterComment";
import type {
  AIProvider,
  GenerateParams,
  GenerateResult,
} from "../../src/ai/types";
import type { WorkEntry } from "../../src/models/types";
import { workspace } from "./support/vscodeStub";

/**
 * 本文を読んで言う一言を、AIへ頼みに行くところ（設計書6.21.4、P-34）。
 *
 * **投げる前に黙る道**を重点的に見る。有料のAI・書きかけの数行・
 * 取り込み途中の本文は、呼ぶだけ無駄か、まともな感想にならない。
 */
const work: WorkEntry = {
  id: "work_1",
  title: "作品",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const manuscriptPath = "C:\\novels\\work\\001.txt";

/** 送られた依頼を覗ける作り物のAI */
function stubProvider(
  options: { paid?: boolean; answer?: string } = {}
): AIProvider & { calls: GenerateParams[] } {
  const calls: GenerateParams[] = [];
  return {
    calls,
    id: "ollama",
    displayName: "作り物",
    isPaid: options.paid ?? false,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate: async (params: GenerateParams): Promise<GenerateResult> => {
      calls.push(params);
      return {
        text: options.answer ?? '{"comment":"戦闘の緊張感が伝わってきます。"}',
        truncated: false,
        elapsedMs: 1,
      };
    },
  };
}

/** 本文を1つだけ置く */
function putManuscript(text: string): void {
  const bytes = new TextEncoder().encode(text);
  (workspace.fs as Record<string, unknown>).readFile = async () => bytes;
}

const body = "彼は剣を握り直した。\n".repeat(60);

beforeEach(() => putManuscript(body));

describe("投げる前に黙る", () => {
  test("AIが未設定なら投げない", async () => {
    const signal = new AbortController().signal;

    await expect(
      requestChatterComment(work, manuscriptPath, () => undefined, signal)
    ).resolves.toBeUndefined();
  });

  test("有料のAIには投げない", async () => {
    // **頼まれていない発言で課金しない。** 独り言の側でも見ているが、
    // 実際に金を使うのはこちらなので、ここでも見る
    const provider = stubProvider({ paid: true });

    const result = await requestChatterComment(
      work,
      manuscriptPath,
      () => ({ provider, model: "m" }),
      new AbortController().signal
    );

    expect(provider.calls).toHaveLength(0);
    expect(result).toBeUndefined();
  });

  test("書きかけの数行には投げない", async () => {
    // 「盛り上がってきましたね」が的外れになる
    putManuscript("書き始め。");
    const provider = stubProvider();

    const result = await requestChatterComment(
      work,
      manuscriptPath,
      () => ({ provider, model: "m" }),
      new AbortController().signal
    );

    expect(provider.calls).toHaveLength(0);
    expect(result).toBeUndefined();
  });

  test("競合マーカーの残った本文には投げない", async () => {
    putManuscript(`<<<<<<< HEAD\n${body}`);
    const provider = stubProvider();

    const result = await requestChatterComment(
      work,
      manuscriptPath,
      () => ({ provider, model: "m" }),
      new AbortController().signal
    );

    expect(provider.calls).toHaveLength(0);
    expect(result).toBeUndefined();
  });
});

describe("投げるとき", () => {
  test("渡すのは話の末尾だけ", async () => {
    putManuscript(`ここが冒頭です。\n${"あ".repeat(3_000)}\n最後の一行。`);
    const provider = stubProvider();

    await requestChatterComment(
      work,
      manuscriptPath,
      () => ({ provider, model: "m" }),
      new AbortController().signal
    );

    const sent = provider.calls[0].userPrompt;
    expect(sent).toContain("最後の一行。");
    expect(sent).not.toContain("ここが冒頭です。");
  });

  test("答えを読み取って返す（コードフェンス付きでも読む）", async () => {
    const provider = stubProvider({
      answer: '```json\n{"comment":"静かな幕切れですね。"}\n```',
    });

    const result = await requestChatterComment(
      work,
      manuscriptPath,
      () => ({ provider, model: "m" }),
      new AbortController().signal
    );

    expect(result).toBe("静かな幕切れですね。");
  });

  test("読めない答えは undefined（呼び出し側が黙る）", async () => {
    const provider = stubProvider({ answer: "すみません、分かりません。" });

    const result = await requestChatterComment(
      work,
      manuscriptPath,
      () => ({ provider, model: "m" }),
      new AbortController().signal
    );

    expect(result).toBeUndefined();
  });

  test("中止の合図をAIまで渡す", async () => {
    // 30秒で諦めるための合図。ここで落とすと、待ち続ける道ができる
    const provider = stubProvider();
    const controller = new AbortController();

    await requestChatterComment(
      work,
      manuscriptPath,
      () => ({ provider, model: "m" }),
      controller.signal
    );

    expect(provider.calls[0].signal).toBe(controller.signal);
  });
});
