import { beforeEach, describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { assignFeatureAI } from "../../src/features/assignFeatureAI";
import {
  AIRegistry,
  ASSIGNABLE_FEATURES,
  ASSIGNABLE_FEATURE_LABELS,
} from "../../src/ai/registry";
import type { AIProvider, ModelInfo, ProviderId } from "../../src/ai/types";
import { statusBarMessages, window } from "./support/vscodeStub";

/**
 * 「機能ごとにAIを割り当てる」の選択画面（設計書6.28.7の1）。
 * 実機確認リスト F-24。
 *
 * QuickPick が実際に開くことと、割当先を選ぶウィザード（鍵→接続→モデル→
 * 生成テスト）は実機に残る。ここで見るのは**並ぶ機能と、その右に出る
 * いまの割当**、そして**「既定のAIを使う（割当を外す）」で元へ戻ること**。
 */

const KEY_ASSIGNMENTS = "novelai.ai.featureAssignments";

function modelOf(id: string): ModelInfo {
  return {
    id,
    displayName: id,
    contextWindow: 131072,
    parameterSize: "8B",
    capabilities: ["JSON"],
    tier: "standard",
  };
}

function fakeProvider(id: ProviderId, displayName: string): AIProvider {
  return {
    id,
    displayName,
    isPaid: false,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "ok", modelCount: 1 }),
    listModels: async () => [modelOf("gemma4:e4b")],
    generate: async () => ({ text: "" }),
  } as unknown as AIProvider;
}

function setup(initial: Record<string, unknown> = {}): {
  registry: AIRegistry;
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

  const registry = new AIRegistry(context);
  const map = (
    registry as unknown as { providers: Map<ProviderId, AIProvider> }
  ).providers;
  map.clear();
  map.set("ollama", fakeProvider("ollama", "Ollama（ローカル）"));
  map.set("gemini", fakeProvider("gemini", "Google Gemini"));
  return { registry, store };
}

/** 出た選択肢（label と description の対）を、問いごとに積む */
let rounds: Array<Array<{ label: string; description?: string; detail?: string }>> = [];
let shown: string[] = [];

/** 何番目の選択肢を選ぶか（問いごと。undefined は閉じる） */
let picks: Array<number | undefined> = [];

beforeEach(() => {
  rounds = [];
  shown = [];
  picks = [];
  statusBarMessages.length = 0;
  let asked = 0;
  Object.assign(window, {
    showQuickPick: async (items: Array<Record<string, unknown>>) => {
      rounds.push(
        items.map((item) => ({
          label: String(item.label ?? ""),
          description:
            typeof item.description === "string" ? item.description : undefined,
          detail: typeof item.detail === "string" ? item.detail : undefined,
        }))
      );
      const at = picks[asked];
      asked += 1;
      return at === undefined ? undefined : items[at];
    },
    showInformationMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
  });
});

describe("機能の一覧", () => {
  test("割り当てられる機能が、決まった順で並ぶ（実機確認リスト F-24 の代わり）", async () => {
    const { registry } = setup();
    picks = [undefined];

    await assignFeatureAI(registry);

    // 末尾の「取りやめる」を除いた並び
    const labels = rounds[0].slice(0, -1).map((item) => item.label);
    expect(labels).toEqual(
      ASSIGNABLE_FEATURES.map((feature) => ASSIGNABLE_FEATURE_LABELS[feature])
    );
    // 重い（＝手元AIの効きが大きい）ものから
    expect(labels[0]).toBe("設定資料の抽出");
  });

  test("割り当てていない機能は「既定のAIを使う」と出る（実機確認リスト F-24 の代わり）", async () => {
    const { registry } = setup();
    picks = [undefined];

    await assignFeatureAI(registry);

    for (const item of rounds[0].slice(0, -1)) {
      expect(item.description).toBe("既定のAIを使う");
    }
  });

  test("割り当てた機能には、そのAIとモデルが出る（実機確認リスト F-24 の代わり）", async () => {
    const { registry } = setup({
      [KEY_ASSIGNMENTS]: { typo: { provider: "gemini", model: "gemini-2.5" } },
    });
    picks = [undefined];

    await assignFeatureAI(registry);

    const typo = rounds[0].find((item) => item.label === "誤字脱字");
    expect(typo?.description).toBe("割当: Google Gemini / gemini-2.5");
    // ほかの機能は既定のまま
    const proofread = rounds[0].find((item) => item.label === "推敲");
    expect(proofread?.description).toBe("既定のAIを使う");
  });

  /**
   * モデルの大きさで結果が変わる機能だけ、その場で断る（作者の裁定 2026-09-06）。
   *
   * 「設定資料の抽出」を足したのは実測による（2026-09-08、実機確認A-18）。
   * 本番のプロンプトとスキーマのまま、qwen3:8b は別名0件、gemma4:26b は
   * 別名3件（しかも8bより速い）。**モデルを替えるだけで人物の分裂が止まった。**
   * **全部の行に説明を付けない**——付けると肝心の行が埋もれる
   */
  test("説明を添えるのは、モデルの大きさで結果が変わる機能だけ（実機確認リスト F-24 の代わり）", async () => {
    const { registry } = setup();
    picks = [undefined];

    await assignFeatureAI(registry);

    const withDetail = rounds[0]
      .slice(0, -1)
      .filter((item) => item.detail !== undefined)
      .map((item) => item.label);
    expect(withDetail).toEqual(["設定資料の抽出", "誤字脱字"]);
  });
});

describe("割当を外す", () => {
  test("「既定のAIを使う（割当を外す）」で元に戻る（実機確認リスト F-24 の代わり）", async () => {
    const { registry, store } = setup({
      [KEY_ASSIGNMENTS]: { typo: { provider: "gemini", model: "gemini-2.5" } },
    });
    // 1問目：誤字脱字（並びの2番目）、2問目：既定のAIを使う（先頭）
    picks = [ASSIGNABLE_FEATURES.indexOf("typo"), 0];

    await assignFeatureAI(registry);

    expect(store.get(KEY_ASSIGNMENTS)).toEqual({});
    // 外したことは、その場限りの完了としてステータスバーへ出す
    expect(statusBarMessages[0].text).toContain(
      "誤字脱字 は、AI設定で選んだ既定のAIで実行するようにしました。"
    );
  });

  test("いま割当が無ければ、「いまはこちら」と示す（実機確認リスト F-24 の代わり）", async () => {
    const { registry } = setup();
    picks = [ASSIGNABLE_FEATURES.indexOf("typo"), undefined];

    await assignFeatureAI(registry);

    expect(rounds[1][0].label).toBe("既定のAIを使う（割当を外す）");
    expect(rounds[1][0].description).toBe("いまはこちら");
    expect(rounds[1][1].label).toBe("使うAIを選ぶ…");
  });
});
