import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspace } from "../support/vscodeStub";
import { useMemoryTuningStore } from "../support/tuningStore";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../../../src/ai/outputLimit";
import { featureOutputKey } from "../../../src/core/featureOutputTokens";
import { modelTuningKey } from "../../../src/core/modelTuning";

/**
 * **止められない思考のぶんを、出力の見込みへ足す**（設計書6.49.9。作者の
 * 判断、2026-09-26）。
 *
 * 比べ（2026-09-25〜26）で、考えるタイプのモデルが考える途中で出力の上限を
 * 使い切り、答えが空で返った。思考を止める指定が効かないモデルでは、
 * 同梱の表（別のモデルで測った答えの量）のままでは足りない。
 *
 * **このモデル自身の実測には足さない**——実測の出力トークン数には思考の
 * ぶんがもう入っているので、足すと二重に数える。
 */

const PROVIDER = "sakura";
const MODEL = "preview/Kimi-K2.6";

function installSettings(values: Record<string, unknown>): void {
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key in values ? values[key] : defaultValue) as T,
      inspect: () => ({ workspaceValue: undefined }),
      update: async (key: string, value: unknown) => {
        values[key] = value;
      },
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
}

beforeEach(() => {
  installSettings({ maxOutputTokens: 16384 });
});

afterEach(() => {
  workspace.getConfiguration = () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  });
});

/** 思考を止められないと確かめたモデル（1回あたり2,560トークン） */
const UNSUPPRESSED = {
  thinkingSeen: true,
  thinkingOffWorks: false,
  thinkingOverheadTokens: 2560,
};

describe("同梱の見込みには、思考のぶんを足す", () => {
  it("止められないモデルでは、誤字脱字の同梱の見込みに足す（計画も実送信も）", async () => {
    await useMemoryTuningStore({ [modelTuningKey(PROVIDER, MODEL)]: UNSUPPRESSED });
    // 同梱の typo_check は 8,753 → ×1.25・1024刻みで 11,264。＋2,560 = 13,824
    expect(resolveOutputTokensForPlanning(PROVIDER, MODEL, "typo_check")).toBe(13824);
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "typo_check")).toBe(13824);
  });

  it("止まるモデル・見分けていないモデルでは、これまでどおり", async () => {
    await useMemoryTuningStore({
      [modelTuningKey(PROVIDER, MODEL)]: {
        ...UNSUPPRESSED,
        thinkingOffWorks: true,
      },
    });
    expect(resolveOutputTokensForPlanning(PROVIDER, MODEL, "typo_check")).toBe(11264);

    await useMemoryTuningStore({});
    expect(resolveOutputTokensForPlanning(PROVIDER, MODEL, "typo_check")).toBe(11264);
  });

  it("機能の実測が無いときの当て推量（8,192）にも足す", async () => {
    await useMemoryTuningStore({ [modelTuningKey(PROVIDER, MODEL)]: UNSUPPRESSED });
    // 同梱の表に無い機能名
    expect(resolveOutputTokensForPlanning(PROVIDER, MODEL, "未測定の機能")).toBe(
      8192 + 2560
    );
  });

  it("設定の上限は超えない（作者が設定で下げたなら、そちらが勝つ）", async () => {
    installSettings({ maxOutputTokens: 12000 });
    await useMemoryTuningStore({ [modelTuningKey(PROVIDER, MODEL)]: UNSUPPRESSED });
    expect(resolveOutputTokensForPlanning(PROVIDER, MODEL, "typo_check")).toBe(12000);
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "typo_check")).toBe(12000);
  });
});

describe("このモデル自身の実測には足さない（二重に数えない）", () => {
  it("機能の実測がこのモデルにあれば、そのまま使う", async () => {
    await useMemoryTuningStore({
      [modelTuningKey(PROVIDER, MODEL)]: UNSUPPRESSED,
      // このモデルの誤字脱字の実測（思考のぶんを含んだ出力トークン数）
      [featureOutputKey("typo_check", PROVIDER, MODEL)]: {
        outputTokens: 4000,
        outputTokenSamples: 3,
      },
    });
    // 4,000 × 1.25 = 5,000 → 1024刻みで 5,120。思考は足さない
    expect(resolveOutputTokensForPlanning(PROVIDER, MODEL, "typo_check")).toBe(5120);
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "typo_check")).toBe(5120);
  });
});
