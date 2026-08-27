import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { AIRegistry, type AssignableFeature } from "../../src/ai/registry";
import type { AIProvider, ModelInfo, ProviderId } from "../../src/ai/types";

/**
 * 機能ごとのAI割当（設計書6.28.7の1、7.1）。
 *
 * **割当が無い＝既定を使う。** 「機能別割当が有効か」のフラグは持たない
 * ので、外したら必ず既定へ戻る。割当先が使えないときも既定へ落とす
 * （止めない）。
 */

const KEY_ASSIGNMENTS = "novelai.ai.featureAssignments";

function modelOf(id: string, contextWindow: number): ModelInfo {
  return {
    id,
    displayName: id,
    contextWindow,
    parameterSize: "8B",
    capabilities: ["JSON"],
    tier: "standard",
  };
}

function fakeProvider(id: ProviderId, models: ModelInfo[]): AIProvider {
  return {
    id,
    displayName: `${id}という名前のAI`,
    isPaid: false,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "ok", modelCount: 1 }),
    listModels: async () => models,
    generate: async () => ({ text: "" }),
  } as unknown as AIProvider;
}

/** globalState だけを持つ最小の文脈。中身は Map で見える */
function fakeContext(initial: Record<string, unknown> = {}): {
  context: vscode.ExtensionContext;
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>(Object.entries(initial));
  const context = {
    globalState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as vscode.ExtensionContext;
  return { context, store };
}

/**
 * 本物のプロバイダを偽物へ差し替える。
 *
 * `AIRegistry` は自分で6種類のプロバイダを組み立てる。そのままだと
 * `resolveModelInfo` が実際にHTTPを叩きにいくので、中身だけを入れ替える。
 */
function useProviders(registry: AIRegistry, providers: AIProvider[]): void {
  const map = (
    registry as unknown as { providers: Map<ProviderId, AIProvider> }
  ).providers;
  map.clear();
  for (const provider of providers) map.set(provider.id, provider);
}

function setup(initial: Record<string, unknown> = {}): {
  registry: AIRegistry;
  store: Map<string, unknown>;
} {
  const { context, store } = fakeContext(initial);
  const registry = new AIRegistry(context);
  useProviders(registry, [
    fakeProvider("ollama", [modelOf("gemma4:e4b", 131072)]),
    fakeProvider("lmstudio", [modelOf("gemma4:e4b", 8192)]),
  ]);
  return { registry, store };
}

describe("機能ごとのAI割当", () => {
  test("割当が無ければ、既定のAIが返る", async () => {
    const { registry } = setup();
    await registry.select("ollama", "gemma4:e4b");

    const resolved = registry.resolve("typo");

    expect(resolved?.provider.id).toBe("ollama");
    expect(resolved?.model).toBe("gemma4:e4b");
  });

  test("割当があれば、割当のAIが返る（既定は変わらない）", async () => {
    const { registry } = setup();
    await registry.select("ollama", "gemma4:e4b");

    await registry.assign("typo", "lmstudio", "gemma4:e4b");

    expect(registry.resolve("typo")?.provider.id).toBe("lmstudio");
    // 割り当てていない機能と、機能に紐付かない場所は既定のまま
    expect(registry.resolve("extract")?.provider.id).toBe("ollama");
    expect(registry.resolve("default")?.provider.id).toBe("ollama");
    expect(registry.selectedProviderId).toBe("ollama");
  });

  /**
   * **止めない。** 割当先のプロバイダが無くなった端末（ブラウザ版で
   * 手元のAIを割り当てていた、など）で全機能が死ぬのは、作者から見て
   * 「壊れた」としか見えない。既定へ落として記録に残す。
   */
  test("割当のプロバイダが登録に無ければ、既定へ落ちる", async () => {
    const { registry } = setup({
      [KEY_ASSIGNMENTS]: {
        typo: { provider: "claude", model: "claude-x" },
      },
    });
    await registry.select("ollama", "gemma4:e4b");
    // 割当そのものは読めていること。読めていなければ、この検査は
    // 「割当が無いから既定が返った」を確かめただけになる
    expect(registry.assignments().typo?.provider).toBe("claude");

    const resolved = registry.resolve("typo");

    expect(resolved?.provider.id).toBe("ollama");
    expect(resolved?.model).toBe("gemma4:e4b");
  });

  test("割当を外すと、既定へ戻る", async () => {
    const { registry, store } = setup();
    await registry.select("ollama", "gemma4:e4b");
    await registry.assign("proofread", "lmstudio", "gemma4:e4b");

    await registry.unassign("proofread");

    expect(registry.resolve("proofread")?.provider.id).toBe("ollama");
    expect(registry.assignments().proofread).toBeUndefined();
    // 外した印はフラグではなく「キーが無い」ことで表す（設計書6.28.7）
    expect(store.get(KEY_ASSIGNMENTS)).toEqual({});
  });

  /**
   * **ここを渡し忘れると、入力が黙って切り捨てられる。**
   * 既定モデルのコンテキスト長で本文を切って、別のモデルへ送ることになる。
   */
  test("モデル情報も、割当のモデルのものが返る", async () => {
    const { registry } = setup();
    await registry.select("ollama", "gemma4:e4b");
    await registry.assign("extract", "lmstudio", "gemma4:e4b");

    const assigned = await registry.resolveModelInfo("extract");
    const fallback = await registry.resolveModelInfo("typo");

    // 同じモデル名でも、サービスが違えば文脈長が違う
    expect(assigned?.contextWindow).toBe(8192);
    expect(fallback?.contextWindow).toBe(131072);
  });

  test("割当を変えると、開いたままのパネルへ合図が飛ぶ", async () => {
    const { registry } = setup();
    let fired = 0;
    registry.onDidChangeSelection(() => {
      fired++;
    });

    await registry.assign("chat", "lmstudio", "gemma4:e4b");
    await registry.unassign("chat");

    expect(fired).toBe(2);
  });
});

/**
 * 機能キーの取り違えを止める。
 *
 * **隣の機能から写して直し忘れる形が、いちばん起きやすい。**
 * 誤字脱字の実装に `"proofread"` と書いても、型は通り、動きもする——
 * ただし作者が推敲へ割り当てたAIで誤字脱字が走る。**画面にも出ない。**
 * 検査ファイルは1機能につき1つなので、その中に別の機能キーが出てきたら
 * 写し間違いである。
 */
describe("検査ファイルは自分の機能キーだけを渡す", () => {
  const expected: Array<[string, AssignableFeature]> = [
    ["src/features/checkTypos.ts", "typo"],
    ["src/features/checkProofread.ts", "proofread"],
    ["src/features/checkContradictions.ts", "contradiction"],
    ["src/features/checkDeviations.ts", "deviation"],
    ["src/features/extractCharacters.ts", "extract"],
  ];

  /**
   * `resolve("…")` / `resolveModelInfo("…")` / `ensureConfigured(x, "…")` の
   * 引数に書かれた機能キーを拾う。コメントの中の `resolveModelInfo()` は
   * 引用符が無いので当たらない。
   */
  function keysIn(file: string): string[] {
    const source = readFileSync(file, "utf-8");
    const pattern =
      /\b(?:resolveModelInfo|resolve)\(\s*"([a-z]+)"|\bensureConfigured\([^)]*?,\s*"([a-z]+)"/g;
    const found: string[] = [];
    for (const match of source.matchAll(pattern)) {
      found.push(match[1] ?? match[2]);
    }
    return found;
  }

  test.each(expected)("%s は %s だけを渡す", (file, feature) => {
    const keys = keysIn(file);
    // 拾い方を間違えて0件を通す、を防ぐ
    expect(keys.length).toBeGreaterThan(0);
    expect([...new Set(keys)]).toEqual([feature]);
  });
});
