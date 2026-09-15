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
    /*
      **既定は id ごとに別にする。** 同じ `version` は「同じ実体の別名」
      として畳まれる（実装の `usableModels`）ので、作り物で共有すると
      **関係ないモデルまで1つにまとまり、テストが実物と違う形になる。**
    */
    version: overrides.version ?? `v-${overrides.id ?? "gpt-x"}`,
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

/**
 * **選択肢が多い**（作者の実機、2026-09-16：23件返った）。
 *
 * 作者の指摘：「選択肢が多すぎる印象です。無料か有料かを判断して、
 * オート等使えるものだけ出したほうが良いかもしれません」。
 *
 * **落とさずに、順番だけ変える。** どれが使えるかを機械で見分ける手立てが
 * （VS Code 1.90 の型には）無いので、**当て推量で選択肢を消さない**。
 * Copilot の無料枠は**自動選択しか使えない**ので、先頭に置く値打ちは高い。
 */
describe("選択肢の並び", () => {
  test("**自動選択を先頭に置く**", async () => {
    setStubChatModels([
      stubModel({ id: "gpt-4o-mini", name: "GPT-4o mini", family: "gpt-4o-mini" }),
      stubModel({ id: "auto", name: "Auto", family: "auto" }),
      stubModel({ id: "claude", name: "Claude", family: "claude" }),
    ]);
    const models = await new VsCodeLmProvider().listModels();
    expect(models[0].displayName).toContain("Auto");
  });

  test("落とさない（件数は変わらない）", async () => {
    // **当て推量で消すと、使えるものまで落とす**
    setStubChatModels([
      stubModel({ id: "auto" }),
      stubModel({ id: "a" }),
      stubModel({ id: "b" }),
    ]);
    const models = await new VsCodeLmProvider().listModels();
    expect(models).toHaveLength(3);
  });

  test("自動選択が無ければ、並びはそのまま", async () => {
    setStubChatModels([
      stubModel({ id: "a", name: "A" }),
      stubModel({ id: "b", name: "B" }),
    ]);
    const models = await new VsCodeLmProvider().listModels();
    expect(models.map((m) => m.displayName)).toEqual([
      "A（copilot）",
      "B（copilot）",
    ]);
  });

  test("automatic のような別の語を、自動選択と読み違えない", async () => {
    // `\bauto\b` で見るので、語の一部には当たらない
    setStubChatModels([
      stubModel({ id: "autobots", name: "Autobots", family: "x" }),
      stubModel({ id: "plain", name: "Plain", family: "y" }),
    ]);
    const models = await new VsCodeLmProvider().listModels();
    expect(models[0].displayName).toContain("Autobots");
  });
});

/**
 * **作者の環境で実際に返った23件**（2026-09-16 のログ）を、そのまま通す。
 *
 * > 選択肢が多すぎる印象です。無料か有料かを判断して、オート等使えるものだけ
 * > 出したほうが良いかもしれません
 *
 * 23件の正体は、**16件が手元の Ollama の二重掲載**だった
 * （`ollama` と `ollama-models` で同じ8つ）。ほかに、本文を1文字も送れない
 * もの（`maxInputTokens: 0`）と、同じ実体の別名が混ざっていた。
 *
 * **作り物の数字ではなく、実物で確かめる。** ここが緩むと、次に顔ぶれが
 * 変わったときに「なぜこの規則なのか」が分からなくなる。
 */
describe("作者の実環境の23件を絞る", () => {
  /** ログから起こした実物（`sendRequest` だけ足す） */
  const REAL = [
    { id: "gpt-4o-mini", vendor: "copilot", family: "gpt-4o-mini", version: "gpt-4o-mini-2024-07-18", name: "GPT-4o mini", maxInputTokens: 12078 },
    { id: "auto", vendor: "copilot", family: "claude-fable-5.1", version: "claude-fable-5.1", name: "Auto", maxInputTokens: 935793 },
    { id: "copilot-utility-small", vendor: "copilot", family: "copilot-utility-small", version: "gpt-4o-mini-2024-07-18", name: "GPT-4o mini", maxInputTokens: 12078 },
    { id: "copilot-utility", vendor: "copilot", family: "copilot-utility", version: "gpt-5-mini", name: "GPT-5 mini", maxInputTokens: 127790 },
    { id: "copilot-dictation-cleanup-luna", vendor: "copilot", family: "copilot-dictation-cleanup-luna", version: "gpt-5.6-luna", name: "GPT-5.6 Luna", maxInputTokens: 921793 },
    { id: "gpt-5.6-luna", vendor: "copilot", family: "gpt-5.6-luna", version: "gpt-5.6-luna", name: "GPT-5.6 Luna", maxInputTokens: 921793 },
    { id: "auto", vendor: "copilotcli", family: "", version: "", name: "Auto", maxInputTokens: 0 },
    ...["gemma4:26b", "qwen3:8b", "qwen3.8:latest", "bge-m3:latest", "gemma4:12b", "gemma4:e4b", "gemma4:latest", "gemma3:12b"].map(
      (id) => ({ id, vendor: "ollama", family: id, version: "1.0.0", name: id, maxInputTokens: 126976 })
    ),
    ...["gemma4:26b", "qwen3:8b", "qwen3.8:latest", "bge-m3:latest", "gemma4:12b", "gemma4:e4b", "gemma4:latest", "gemma3:12b"].map(
      (id) => ({ id, vendor: "ollama-models", family: "gemma4", version: "1.0", name: id, maxInputTokens: 126976 })
    ),
  ].map((one) => stubModel(one));

  test("23件が4件になる", async () => {
    expect(REAL).toHaveLength(23);
    setStubChatModels(REAL);
    const models = await new VsCodeLmProvider().listModels();
    expect(models.map((m) => m.displayName)).toEqual([
      // **Auto が先頭**（Copilot の無料枠は自動選択しか使えない）
      "Auto（copilot）",
      "GPT-4o mini（copilot）",
      "GPT-5 mini（copilot）",
      "GPT-5.6 Luna（copilot）",
    ]);
  });

  test("**手元の Ollama の又借りを落とす**（16件ぶん）", async () => {
    setStubChatModels(REAL);
    const models = await new VsCodeLmProvider().listModels();
    /*
      この製品は Ollama を直に繋げる。又借りすると `num_ctx` も
      JSONスキーマも渡せず、**明確に劣る**（CLAUDE.md 規則6）。
    */
    expect(models.some((m) => m.displayName.includes("gemma"))).toBe(false);
    expect(models.some((m) => m.displayName.includes("qwen"))).toBe(false);
  });

  test("**本文を1文字も送れないものを落とす**", async () => {
    setStubChatModels(REAL);
    const models = await new VsCodeLmProvider().listModels();
    // copilotcli の Auto は maxInputTokens が 0 だった
    expect(models.some((m) => m.displayName.includes("copilotcli"))).toBe(false);
  });

  test("**同じ実体の別名を畳み、素直な名前を残す**", async () => {
    setStubChatModels(REAL);
    const models = await new VsCodeLmProvider().listModels();
    const ids = models.map((m) => m.id);
    // gpt-4o-mini と copilot-utility-small は同じ version
    expect(ids).toContain("gpt-4o-mini");
    expect(ids).not.toContain("copilot-utility-small");
    // gpt-5.6-luna と copilot-dictation-cleanup-luna も同じ version
    expect(ids).toContain("gpt-5.6-luna");
    expect(ids).not.toContain("copilot-dictation-cleanup-luna");
  });

  test("読める長さは、そのまま引き継ぐ", async () => {
    setStubChatModels(REAL);
    const models = await new VsCodeLmProvider().listModels();
    const auto = models.find((m) => m.id === "auto");
    expect(auto?.contextWindow).toBe(935793);
  });
});
