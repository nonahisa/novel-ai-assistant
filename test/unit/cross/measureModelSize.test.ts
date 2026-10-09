import { describe, expect, it } from "vitest";
import {
  decideProductOptions,
  describeModelSize,
  isSizeDependentFeature,
} from "../../../scripts/measureModelSize.mjs";
import {
  capabilityProfile,
  useSmallModelTypoPrompt,
} from "../../../src/ai/capability";
import { inferTier } from "../../../src/ai/types";

/*
  測定台が、製品と同じ「モデルの大きさに合わせた頼み方」で撃つか
  （`scripts/measure.mjs` → `scripts/measureModelSize.mjs`、2026-10-10）。

  2026-10-05・10-08 の誤字脱字の測定は、台本が大きさを渡していなかったため、
  製品が `gemma4:e4b`（8B）へ送らない大きいモデル向けの文（P-09 の 1.2）で
  撃っていた。ここで確かめるのは4つ。

    ① 製品の関数（束から借りるものと同じ `ai/capability.ts`）を渡すと、
       e4b は小さい側・26b は大きい側の名前になる
    ② 打たれた `--option` が勝ち、勝ったことが記録に出る
    ③ さくらでは決めず、理由を返す（黙って大きいモデル向けで回さない）
    ④ 大きさで頼み方を変えない機能には何も足さない
*/

const capability = { useSmallModelTypoPrompt, capabilityProfile, inferTier };

function decide(
  feature: string,
  parameterSize: string | null,
  given: Record<string, string> = {},
  runner = "ollama"
) {
  return decideProductOptions({
    feature,
    runner,
    parameterSize,
    given,
    capability,
  });
}

describe("製品と同じ判断で頼み方を決める", () => {
  it("誤字脱字：e4b（8.0B）は small、26b（25.2B）は large", () => {
    expect(decide("typo", "8.0B").options).toEqual({ modelSize: "small" });
    expect(decide("typo", "25.2B").options).toEqual({ modelSize: "large" });
  });

  it("逸脱：e4b は「逸脱」だけ（small）、26b は2種（large）", () => {
    expect(decide("deviation", "8.0B").options).toEqual({ modelSize: "small" });
    expect(decide("deviation", "25.2B").options).toEqual({ modelSize: "large" });
  });

  it("矛盾検知：e4b は 観点を絞る＋抑制、26b は 全観点＋ゆるめる", () => {
    expect(decide("contradiction", "8.0B").options).toEqual({
      categories: "light",
      suppression: "strict",
    });
    expect(decide("contradiction", "25.2B").options).toEqual({
      categories: "all",
      suppression: "loose",
    });
  });

  it("大きさが取れなければ、製品と同じく手元のAIは小さい側へ落ちる", () => {
    expect(decide("typo", null).options).toEqual({ modelSize: "small" });
    expect(decide("typo", null).decision).toMatchObject({
      decided: true,
      tier: "light",
      parameterSize: null,
    });
  });

  it("根拠（申告の大きさ・ティア）を記録へ残す", () => {
    const { decision } = decide("typo", "8.0B");
    expect(decision).toMatchObject({
      sizeDependent: true,
      decided: true,
      providerId: "ollama",
      parameterSize: "8.0B",
      tier: "standard",
      product: { modelSize: "small" },
      kept: [],
    });
  });
});

describe("打たれた --option が勝つ", () => {
  it("打った modelSize はそのまま。製品の条件ではないと記録に出る", () => {
    const { options, decision } = decide("typo", "8.0B", { modelSize: "large" });
    expect(options).toEqual({ modelSize: "large" });
    expect(decision.kept).toEqual(["modelSize"]);
    expect(decision.source).toContain("製品の条件ではありません");
  });

  it("関係のない --option は残したまま、足りない名前だけ埋める", () => {
    const { options } = decide("contradiction", "8.0B", { carryOver: "0" });
    expect(options).toEqual({
      categories: "light",
      suppression: "strict",
      carryOver: "0",
    });
  });
});

describe("決めない場合", () => {
  it("さくらでは決めず、理由を返す", () => {
    const { options, decision } = decide("typo", null, {}, "sakura");
    expect(options).toEqual({});
    expect(decision.sizeDependent).toBe(true);
    expect(decision.decided).toBe(false);
    expect(describeModelSize(decision, "1.2")).toContain("大きさで決めていません");
  });

  it("推敲は大きさで頼み方を変えないので、何も足さず行も出さない", () => {
    expect(isSizeDependentFeature("proofread")).toBe(false);
    const { options, decision } = decide("proofread", "8.0B");
    expect(options).toEqual({});
    expect(describeModelSize(decision, "1.9")).toBeNull();
  });
});

describe("結果の行", () => {
  it("名前・申告の大きさ・版を1行に出す", () => {
    const line = describeModelSize(decide("typo", "8.0B").decision, "1.1");
    expect(line).toContain("modelSize=small");
    expect(line).toContain("8.0B");
    expect(line).toContain("版 1.1");
  });
});
