import { beforeEach, describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { assignFeatureAI } from "../../../src/features/assignFeatureAI";
import {
  AIRegistry,
  ASSIGNABLE_FEATURES,
  ASSIGNABLE_FEATURE_LABELS,
} from "../../../src/ai/registry";
import type { AIProvider, ModelInfo, ProviderId } from "../../../src/ai/types";
import { statusBarMessages, window } from "../support/vscodeStub";
import { useMemoryTuningStore } from "../support/tuningStore";
import { TYPO_CHECK_VERSION } from "../../../src/prompts/typoCheck";
import { TUNING_WORK_SAMPLE_VERSION } from "../../../src/core/tuningWorkSample";

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

beforeEach(async () => {
  // 台帳は毎回空から（精度の目安のテストが置いた値を持ち越さない）
  await useMemoryTuningStore({});
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
    // 伏線は 2026-09-26 の測定で足した（回収の確認で既定の 4B 級が21件中0件）
    expect(withDetail).toEqual(["設定資料の抽出", "誤字脱字", "伏線の検知"]);
  });
});

/**
 * 誤字脱字の行に、AIチューニングで測った**精度の目安**を並べる（設計書6.49.9）。
 *
 * **作者が採った率が主で、目安は添え物**。同梱の文は4段落しかないので、
 * 1件で大きく動く。頼み方の版が変わった結果は、古いと言って出す。
 */
describe("誤字脱字の精度の目安", () => {
  const ASSIGNED = {
    [KEY_ASSIGNMENTS]: { typo: { provider: "gemini", model: "gemini-2.5" } },
  };
  function measured(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      "gemini/gemini-2.5": {
        typoAccuracyHits: 5,
        typoAccuracyTotal: 7,
        typoAccuracyFalsePositives: 1,
        typoAccuracyWrongFixes: 0,
        typoAccuracyPromptVersion: TYPO_CHECK_VERSION,
        typoAccuracySmallPrompt: false,
        typoAccuracySampleVersion: TUNING_WORK_SAMPLE_VERSION,
        typoAccuracyMeasuredAt: "2026-09-26T00:00:00.000Z",
        ...overrides,
      },
    };
  }
  function typoDetail(): string | undefined {
    return rounds[0].find((item) => item.label === "誤字脱字")?.detail;
  }

  test("作者の判断が無ければ、目安だけを「目安」と名乗って出す", async () => {
    await useMemoryTuningStore(measured());
    const { registry } = setup(ASSIGNED);
    picks = [undefined];

    await assignFeatureAI(registry);

    expect(typoDetail()).toContain("gemini-2.5：目安（同梱の短い文で測定）：7件中5件・誤検出1");
  });

  test("作者が採った率があれば、そちらを先に出し、目安は後ろに添える", async () => {
    await useMemoryTuningStore(measured());
    const { registry } = setup(ASSIGNED);
    picks = [undefined];

    await assignFeatureAI(registry, [
      { providerId: "gemini", model: "gemini-2.5", feature: "typo", accepted: 20, dismissed: 5 },
    ]);

    const detail = typoDetail() ?? "";
    expect(detail).toContain("作者が採った率 80%（25件中）");
    expect(detail).toContain("目安（同梱の短い文で測定）：7件中5件・誤検出1");
    expect(detail.indexOf("作者が採った率")).toBeLessThan(detail.indexOf("目安"));
  });

  test("頼み方の版が変わる前の結果は、古いと言って出す", async () => {
    await useMemoryTuningStore(measured({ typoAccuracyPromptVersion: "0.9" }));
    const { registry } = setup(ASSIGNED);
    picks = [undefined];

    await assignFeatureAI(registry);

    expect(typoDetail()).toContain("古い結果");
  });

  test("ほかの機能の行には出さない", async () => {
    await useMemoryTuningStore(measured());
    const { registry } = setup({
      [KEY_ASSIGNMENTS]: {
        typo: { provider: "gemini", model: "gemini-2.5" },
        proofread: { provider: "gemini", model: "gemini-2.5" },
      },
    });
    picks = [undefined];

    await assignFeatureAI(registry);

    const proofread = rounds[0].find((item) => item.label === "推敲");
    expect(proofread?.detail ?? "").not.toContain("目安");
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
