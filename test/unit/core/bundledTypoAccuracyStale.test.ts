import { describe, expect, test, vi } from "vitest";
import { modelTuning } from "../../../src/core/modelTuning";
import { describeTypoAccuracyHint } from "../../../src/core/tuningAccuracy";
import { useMemoryTuningStore } from "../support/tuningStore";

/**
 * **同梱の精度の目安は、頼み方の版が変わったら使わない**（2026-09-26）。
 *
 * 同梱の表は定数なので、「頼み方（P-09）を上げた次の版」を、版を返す関数を
 * 差し替えて作る。当たりは頼み方で動く——版の違う「7件中6件」を、いまの
 * 頼み方の目安として出してはいけない。
 *
 * 差し替えはこのファイル全体に効く（vitest の `vi.mock` は巻き上げられる）
 * ので、ほかの確かめとは別のファイルに置いてある。
 */
vi.mock("../../../src/prompts/typoCheck", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/prompts/typoCheck")>();
  return {
    ...original,
    typoPromptVersion: (forSmallModel: boolean): string =>
      forSmallModel ? "9.8" : "9.9",
  };
});

describe("頼み方の版が変わったあと", () => {
  test("同梱の精度の目安は混ざらず、画面にも出ない", async () => {
    await useMemoryTuningStore({});

    const kimi = modelTuning("sakura", "preview/Kimi-K2.6");
    expect(kimi?.typoAccuracyHits).toBeUndefined();
    expect(kimi?.bundledFields).not.toContain("typoAccuracyHits");
    expect(describeTypoAccuracyHint(kimi)).toBeUndefined();

    // 小さいモデル向けの版で測った e4b も同じ
    expect(modelTuning("ollama", "gemma4:e4b")?.typoAccuracyHits).toBeUndefined();
  });

  test("版に関わらない考えるモデルの性質は、そのまま使う", async () => {
    await useMemoryTuningStore({});

    expect(modelTuning("sakura", "preview/Kimi-K2.6")?.thinkingOffWorks).toBe(true);
  });
});
