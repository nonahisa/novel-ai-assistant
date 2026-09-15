import { describe, expect, test, beforeEach, vi } from "vitest";
import {
  LanguageModelError,
  CancellationError,
  setStubChatModels,
  type StubChatModel,
} from "./support/vscodeStub";
import { VsCodeLmProvider } from "../../src/ai/vscodeLmProvider";
import { AIError } from "../../src/ai/types";

/**
 * VS Code 経由でつなぐ（設計書6.87.11）。
 *
 * **作者の指示（2026-09-16）**：「既存の接続先に追加する方針で行きましょう」
 * 「既存のAPIキーとかのところに選択肢として追加すればよいかと思います」。
 *
 * ここで見張りたいのは3つ。
 *
 * 1. **口が無くても、AI設定の一覧ごと壊れないこと。** この接続先が使えない
 *    だけなら困らないが、構築で落ちると **Ollama も Gemini も選べなくなる**
 * 2. **失敗の3つを分けること**（同意していない／枠切れ／モデルが消えた）。
 *    直し方がそれぞれ違う（CLAUDE.md 規則5）
 * 3. **システムの指示が落ちないこと。** この口には System の役が無いので、
 *    落とすと作品の書き方も禁止事項も届かなくなる
 */

/** 送られたメッセージを覚える作り物 */
function stubModel(
  overrides: Partial<StubChatModel> & { reply?: string; fail?: unknown } = {}
): StubChatModel & { sent: Array<{ role: string; content: string }> } {
  const sent: Array<{ role: string; content: string }> = [];
  const model = {
    id: overrides.id ?? "gpt-x",
    name: overrides.name ?? "GPT-X",
    vendor: overrides.vendor ?? "copilot",
    family: overrides.family ?? "gpt",
    version: overrides.version ?? "1",
    maxInputTokens: overrides.maxInputTokens ?? 128000,
    sent,
    async sendRequest(messages: unknown[]) {
      for (const one of messages as Array<{ role: string; content: string }>) {
        sent.push({ role: one.role, content: one.content });
      }
      if (overrides.fail) throw overrides.fail;
      const reply = overrides.reply ?? "こたえ";
      return {
        text: (async function* () {
          yield reply;
        })(),
      };
    },
    async countTokens(text: string) {
      return text.length;
    },
  };
  return model;
}

beforeEach(() => {
  setStubChatModels([]);
});

describe("繋がっていないとき", () => {
  test("**構築で落ちない**（AI設定の一覧が開けなくなるのを防ぐ）", () => {
    expect(() => new VsCodeLmProvider()).not.toThrow();
  });

  test("口そのものが無くても落ちない", async () => {
    /*
      **古い VS Code や、口を塞いだ配布物がありうる。** 在ることを
      当てにすると、この接続先だけでなく設定の画面ごと開けなくなる。
    */
    const vscode = await import("./support/vscodeStub");
    const saved = vscode.lm.selectChatModels;
    try {
      (vscode.lm as { selectChatModels?: unknown }).selectChatModels = undefined;
      const provider = new VsCodeLmProvider();
      await expect(provider.isConfigured()).resolves.toBe(false);
      await expect(provider.listModels()).resolves.toEqual([]);
    } finally {
      (vscode.lm as { selectChatModels?: unknown }).selectChatModels = saved;
    }
  });

  test("1つも見えなければ、繋ぎ方を案内する", async () => {
    const provider = new VsCodeLmProvider();
    expect(await provider.isConfigured()).toBe(false);
    const test = await provider.testConnection();
    expect(test.ok).toBe(false);
    // **何をすれば使えるのかを書く**（断るだけで終わらせない）
    expect(test.message).toContain("Copilot");
    expect(test.message).toContain("鍵");
  });
});

describe("繋がっているとき", () => {
  test("見えたモデルを一覧に出す。**提供元まで出す**", async () => {
    setStubChatModels([
      stubModel({ id: "a", name: "Claude", vendor: "anthropic" }),
      stubModel({ id: "b", name: "GPT-X", vendor: "copilot" }),
    ]);
    const models = await new VsCodeLmProvider().listModels();
    expect(models).toHaveLength(2);
    /*
      **提供元が見えないと選べない。** この口には Copilot だけでなく、
      VS Code へ鍵を入れた各社が混ざって並ぶ
    */
    expect(models[0].displayName).toBe("Claude（anthropic）");
    expect(models[1].displayName).toBe("GPT-X（copilot）");
  });

  test("読める長さは、向こうが教えてくれる値を使う", async () => {
    // CLAUDE.md 規則6：APIが教えてくれる値は必ずAPIを優先する
    setStubChatModels([stubModel({ maxInputTokens: 64000 })]);
    const [model] = await new VsCodeLmProvider().listModels();
    expect(model.contextWindow).toBe(64000);
  });

  test("接続テストに件数が出る", async () => {
    setStubChatModels([stubModel(), stubModel({ id: "b" })]);
    const test = await new VsCodeLmProvider().testConnection();
    expect(test.ok).toBe(true);
    expect(test.modelCount).toBe(2);
  });
});

describe("送るとき", () => {
  test("**システムの指示を落とさない**", async () => {
    const model = stubModel();
    setStubChatModels([model]);
    await new VsCodeLmProvider().generate({
      systemPrompt: "あなたは校正者です",
      userPrompt: "本文です",
      model: "gpt-x",
      temperature: 0,
    });
    /*
      この口には System の役が無い（User と Assistant だけ）。
      **落とすと、作品の書き方も禁止事項も届かなくなる。**
    */
    expect(model.sent).toHaveLength(2);
    expect(model.sent[0].content).toBe("あなたは校正者です");
    expect(model.sent[1].content).toContain("本文です");
  });

  test("形式を強制できないので、JSONだけを返すよう頼む", async () => {
    const model = stubModel();
    setStubChatModels([model]);
    await new VsCodeLmProvider().generate({
      systemPrompt: "指示",
      userPrompt: "本文です",
      model: "gpt-x",
      temperature: 0,
      jsonSchema: { type: "object" },
    });
    // **スキーマを渡す先が無い**（ほかの接続先とここが違う）
    expect(model.sent[1].content).toContain("JSON");
  });

  test("スキーマが無ければ、余計な頼みごとを足さない", async () => {
    const model = stubModel();
    setStubChatModels([model]);
    await new VsCodeLmProvider().generate({
      systemPrompt: "指示",
      userPrompt: "相談です",
      model: "gpt-x",
      temperature: 0,
    });
    expect(model.sent[1].content).toBe("相談です");
  });

  test("流れてくる答えを集めて返す", async () => {
    setStubChatModels([stubModel({ reply: "直すところはありません" })]);
    const result = await new VsCodeLmProvider().generate({
      systemPrompt: "指示",
      userPrompt: "本文",
      model: "gpt-x",
      temperature: 0,
    });
    expect(result.text).toBe("直すところはありません");
    // **使った量は数えられない口なので、0を入れない**
    expect(result.usage).toBeUndefined();
  });

  test("知らないモデルは、選び直すよう言う", async () => {
    setStubChatModels([stubModel({ id: "a" })]);
    await expect(
      new VsCodeLmProvider().generate({
        systemPrompt: "指示",
        userPrompt: "本文",
        model: "存在しないモデル",
        temperature: 0,
      })
    ).rejects.toMatchObject({ kind: "model_not_found" });
  });
});

describe("失敗の3つを分ける", () => {
  async function failWith(error: unknown): Promise<AIError> {
    setStubChatModels([stubModel({ fail: error })]);
    try {
      await new VsCodeLmProvider().generate({
        systemPrompt: "指示",
        userPrompt: "本文",
        model: "gpt-x",
        temperature: 0,
      });
    } catch (caught) {
      return caught as AIError;
    }
    throw new Error("失敗しなかった");
  }

  test("同意していない → もう一度実行して許可する道を示す", async () => {
    const error = await failWith(LanguageModelError.NoPermissions());
    expect(error.kind).toBe("permission_denied");
    expect(error.message).toContain("もう一度");
  });

  test("枠切れ → 待つか、手元のAIへ切り替える道を示す", async () => {
    const error = await failWith(LanguageModelError.Blocked());
    expect(error.kind).toBe("insufficient_credit");
    // **手元のAIという逃げ道を必ず出す**（待つしかないと思わせない）
    expect(error.message).toContain("Ollama");
  });

  test("モデルが消えた → 選び直す道を示す", async () => {
    const error = await failWith(LanguageModelError.NotFound());
    expect(error.kind).toBe("model_not_found");
    expect(error.message).toContain("選び直");
  });

  test("中止は失敗として騒がない", async () => {
    const error = await failWith(new CancellationError());
    expect(error.kind).toBe("aborted");
  });

  test("知らない失敗も握りつぶさない", async () => {
    // CLAUDE.md「エラーは握りつぶさない」
    const error = await failWith(new Error("回線が切れました"));
    expect(error.kind).toBe("unknown");
    expect(error.message).toContain("回線が切れました");
  });
});

describe("接続先としての性質", () => {
  test("**鍵を持たない**（VS Code 側に在る）", async () => {
    const { isApiKeyProvider } = await import("../../src/ai/types");
    expect(isApiKeyProvider(new VsCodeLmProvider())).toBe(false);
  });

  test("枠があるので、課金される扱いにする", () => {
    // 無料枠にも月あたりの上限がある（処理量の確認を出す側に倒す）
    expect(new VsCodeLmProvider().isPaid).toBe(true);
  });

  test("出力の上限は送らない（渡す口が無い）", () => {
    expect(new VsCodeLmProvider().capsOutput).toBe(false);
  });

  test("一覧の名前に提供元を書かない", () => {
    /*
      **「Copilot」と名乗ると、鍵を入れた作者が見つけられない。**
      ここは Copilot 専用の口ではない（作者の指示、2026-09-16）。
    */
    const name = new VsCodeLmProvider().displayName;
    expect(name).toContain("VS Code");
    expect(name).not.toContain("Copilot");
  });
});

describe("ブラウザ版でも選べる", () => {
  test("手元で動くものの一覧に入れない", async () => {
    /*
      `vscode.lm` は **VS Code の口**なので、ブラウザ版（vscode.dev）でも
      動く。`localhost` を叩く Ollama・LM Studio とはそこが違う。
    */
    const { filterProvidersForRuntime } = await import("../../src/ai/registry");
    const provider = new VsCodeLmProvider();
    const kept = filterProvidersForRuntime([provider], false);
    expect(kept).toHaveLength(1);
  });
});
