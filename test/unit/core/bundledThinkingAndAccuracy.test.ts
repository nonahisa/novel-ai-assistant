import { describe, expect, test } from "vitest";
import {
  allModelTuning,
  describeThinkingOverheadSource,
  modelTuning,
  saveModelTuning,
  unsuppressedThinkingTokens,
} from "../../../src/core/modelTuning";
import {
  describeTypoAccuracyHint,
  describeTypoAccuracyRecord,
} from "../../../src/core/tuningAccuracy";
import { TYPO_CHECK_VERSION } from "../../../src/prompts/typoCheck";
import {
  tuningStoreContents,
  useMemoryTuningStore,
} from "../support/tuningStore";

/**
 * **考えるモデルの性質と、誤字脱字の精度の目安の同梱**（2026-09-26）。
 *
 * AIチューニングの「仕事に近い形で測る」（設計書6.49.9）の測定から、機械に
 * 依らない値だけを同梱の表へ足した。ここで固定するのは、同梱の守りの3つ——
 *
 * - **台帳があれば台帳が勝つ**（欄ごとではなく、ひとまとまりで）
 * - **同梱と名乗る**（精度の目安の行・思考のぶんの記録）
 * - **古くなったら使わない**（精度は版の違い。`bundledTypoAccuracyStale.test.ts`）
 */

describe("考えるモデルの性質", () => {
  test("台帳が空なら、同梱の『止められない』が効いて、出どころは同梱と名乗る", async () => {
    await useMemoryTuningStore({});

    const tuning = modelTuning("sakura", "gpt-oss-120b");
    expect(tuning?.thinkingSeen).toBe(true);
    expect(tuning?.thinkingOffWorks).toBe(false);
    expect(tuning?.thinkingOverheadTokens).toBe(2560);
    expect(tuning?.bundledFields).toEqual(
      expect.arrayContaining(["thinkingSeen", "thinkingOffWorks", "thinkingOverheadTokens"])
    );
    expect(unsuppressedThinkingTokens(tuning)).toBe(2560);
    expect(describeThinkingOverheadSource(tuning)).toBe("同梱の初期値（2026-09-26 測定）");
  });

  test("止める指定が効くモデル・考えないモデルは、何も足さない", async () => {
    await useMemoryTuningStore({});

    const kimi = modelTuning("sakura", "preview/Kimi-K2.6");
    expect(kimi?.thinkingSeen).toBe(true);
    expect(kimi?.thinkingOffWorks).toBe(true);
    expect(unsuppressedThinkingTokens(kimi)).toBe(0);
    expect(describeThinkingOverheadSource(kimi)).toBeUndefined();

    const llmJp = modelTuning("sakura", "llm-jp-3.1-8x13b-instruct4");
    expect(llmJp?.thinkingSeen).toBe(false);
    expect(unsuppressedThinkingTokens(llmJp)).toBe(0);

    // 手元のモデルの性質も載る（機械の地力に依らないため）
    expect(modelTuning("ollama", "gemma4:26b")?.thinkingOffWorks).toBe(true);
  });

  /**
   * **3つはひとまとまり。** 欄ごとに埋めると、作者の機械で「考えない」と
   * 見分けたモデルに、同梱の「止められない・2,560トークン」が足される。
   */
  test("台帳に見分けの欄が1つでもあれば、同梱の思考の欄は1つも使わない", async () => {
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": { thinkingSeen: false },
    });

    const tuning = modelTuning("sakura", "gpt-oss-120b");
    expect(tuning?.thinkingSeen).toBe(false);
    expect(tuning?.thinkingOffWorks).toBeUndefined();
    expect(tuning?.thinkingOverheadTokens).toBeUndefined();
    expect(tuning?.bundledFields).not.toContain("thinkingOverheadTokens");
    expect(unsuppressedThinkingTokens(tuning)).toBe(0);
  });

  test("作者の機械で測った思考のぶんは、この機械の実測と名乗る", async () => {
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": {
        thinkingSeen: true,
        thinkingOffWorks: false,
        thinkingOverheadTokens: 3000,
      },
    });

    const tuning = modelTuning("sakura", "gpt-oss-120b");
    expect(unsuppressedThinkingTokens(tuning)).toBe(3000);
    expect(describeThinkingOverheadSource(tuning)).toBe("この機械の実測");
  });
});

describe("誤字脱字の精度の目安", () => {
  test("台帳が空なら同梱の目安が出て、『同梱の測定（日付）』と名乗る", async () => {
    await useMemoryTuningStore({});

    const kimi = modelTuning("sakura", "preview/Kimi-K2.6");
    expect(kimi?.typoAccuracyHits).toBe(6);
    expect(kimi?.bundledFields).toContain("typoAccuracyHits");
    expect(describeTypoAccuracyHint(kimi)).toBe(
      "目安（同梱の測定（2026-09-26）・同梱の短い文）：7件中6件・誤検出0（うち罠0）"
    );
    // 記録の一覧の一文も、作者の測定と見分けられる
    expect(describeTypoAccuracyRecord(kimi)).toBe(
      `誤字脱字：7件中6件・誤検出0件（うち罠0/5）（同梱の測定・2026-09-26・P-09 ${TYPO_CHECK_VERSION}）`
    );
  });

  /**
   * gpt-oss-120b は2回測って揺れた（誤検出1・罠1 と 誤検出0）。**悪いほうを
   * 載せた**——良いほうだけを見せると、罠に掛からないモデルに見える。
   */
  test("揺れたモデルは、罠に掛かった回を載せている", async () => {
    await useMemoryTuningStore({});

    expect(describeTypoAccuracyHint(modelTuning("sakura", "gpt-oss-120b"))).toBe(
      "目安（同梱の測定（2026-09-26）・同梱の短い文）：7件中6件・誤検出1（うち罠1）"
    );
  });

  test("小さいモデル向けの頼み方で測った e4b も、いまの版として出る", async () => {
    await useMemoryTuningStore({});

    const hint = describeTypoAccuracyHint(modelTuning("ollama", "gemma4:e4b"));
    expect(hint).toBe("目安（同梱の測定（2026-09-26）・同梱の短い文）：7件中3件・誤検出0（うち罠0）");
  });

  /**
   * **作者の測定が古い版のものでも、台帳が勝つ。** 同梱で黙って差し替えると、
   * 作者が測った事実が見えなくなる。古い結果は古いと言って出る。
   */
  test("台帳に精度の結果があれば、古い版でも台帳を使う", async () => {
    await useMemoryTuningStore({
      "sakura/preview/Kimi-K2.6": {
        typoAccuracyHits: 7,
        typoAccuracyTotal: 7,
        typoAccuracyFalsePositives: 0,
        typoAccuracyPromptVersion: "1.2",
        typoAccuracySmallPrompt: false,
        typoAccuracySampleVersion: "1",
        typoAccuracyMeasuredAt: "2026-09-25T21:00:00.000Z",
      },
    });

    const kimi = modelTuning("sakura", "preview/Kimi-K2.6");
    expect(kimi?.typoAccuracyHits).toBe(7);
    expect(kimi?.typoAccuracyTrapTotal).toBeUndefined();
    expect(kimi?.bundledFields).not.toContain("typoAccuracyHits");
    const hint = describeTypoAccuracyHint(kimi);
    expect(hint).toContain("7件中7件");
    expect(hint).toContain("古い結果");
    expect(hint).not.toContain("同梱の測定");
  });

  test("測っていないモデルには、目安を作らない", async () => {
    await useMemoryTuningStore({});

    // Qwen3.6 は文の版1（罠なし）でしか測っていないので、載せていない
    expect(modelTuning("sakura", "preview/Qwen3.6-35B-A3B")?.typoAccuracyHits).toBeUndefined();
    expect(describeTypoAccuracyHint(modelTuning("sakura", "preview/Qwen3.6-35B-A3B"))).toBeUndefined();
  });
});

describe("同梱の新しい欄も、台帳へ焼き付かない", () => {
  /**
   * 読む側は印（`bundled`・`bundledFields`）で同梱を見分ける。印だけが
   * 落ちて値が台帳へ入ると、同梱の値が作者の実測の顔をする。保存の口は
   * 呼び出し側が渡した欄だけを書くので、**読んだだけでは台帳は変わらない**。
   */
  test("読むだけでは台帳に何も書かない", async () => {
    await useMemoryTuningStore({});

    modelTuning("sakura", "gpt-oss-120b");
    allModelTuning();
    expect(tuningStoreContents()).toEqual({});

    await saveModelTuning("sakura", "preview/Kimi-K2.6", { timeoutSeconds: 180 });
    expect(tuningStoreContents()["sakura/preview/Kimi-K2.6"]).toEqual({
      timeoutSeconds: 180,
    });
  });
});
