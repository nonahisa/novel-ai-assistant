import { describe, expect, test } from "vitest";
import {
  adviseLargerModel,
  describeLargerModelAdvice,
  largerModelButtons,
  type CandidateSpeeds,
  type InstalledModel,
} from "../../../src/core/largerModelAdvice";
import {
  accuracyRecordFor,
  describeAccuracyComparison,
  type FeatureAccuracyRecord,
} from "../../../src/core/bundledFeatureAccuracy";

/**
 * **この機械で上限内に終わる、いちばん大きいモデルを案内する**
 * （作者の裁定、2026-09-23。A3④）。
 *
 * 見ること：
 * - 大きいモデルがあり、上限内に終わる見込みのときだけ勧める
 * - 速さを測っていない大きいモデルは、時間を作らずに「測る」へ回す
 * - クラウドのAIでは出さない
 * - 「当たりが多い」は記録が両方あるときだけ言う
 */

const E4B: InstalledModel = { id: "gemma4:e4b", parameterSize: "8.0B" };
const B12: InstalledModel = { id: "gemma4:12b", parameterSize: "12.2B" };
const B26: InstalledModel = { id: "gemma4:26b", parameterSize: "25.2B" };
const B31: InstalledModel = { id: "gemma4:31b", parameterSize: "30.7B" };

/** 作者の機械の e4b・26b に近い速さ（台帳の実測の形） */
const FAST: CandidateSpeeds = {
  inputTokensPerSecond: 2000,
  outputTokensPerSecond: 60,
  outputTokensPerCall: 1000,
  tokensPerChar: 0.8,
  basis: "average",
};
const SLOW: CandidateSpeeds = {
  inputTokensPerSecond: 30,
  outputTokensPerSecond: 3,
  outputTokensPerCall: 6000,
  tokensPerChar: 0.8,
  basis: "average",
};
const UNMEASURED: CandidateSpeeds = { tokensPerChar: 0.8, basis: "bundled-max" };

function advise(
  overrides: Partial<Parameters<typeof adviseLargerModel>[0]> = {}
) {
  return adviseLargerModel({
    providerId: "ollama",
    feature: "contradiction",
    promptVersion: "1.6",
    current: E4B,
    installed: [E4B, B12, B26],
    timeoutSeconds: 1800,
    inputChars: [18000, 18000, 12000],
    speedsOf: () => FAST,
    ...overrides,
  });
}

describe("勧める条件", () => {
  test("大きいモデルがあり、上限内に終わるなら、いちばん大きいものを勧める", () => {
    const advice = advise();
    expect(advice?.fits?.id).toBe("gemma4:26b");
    expect(advice?.fits?.parameterSize).toBe("25.2B");
    expect(advice?.unmeasured).toBeUndefined();
    expect(advice?.fits?.totalMs).toBeGreaterThan(0);
  });

  test("いまのモデルより大きいものが無ければ、何も出さない", () => {
    expect(advise({ current: B26 })).toBeUndefined();
    expect(advise({ installed: [E4B] })).toBeUndefined();
  });

  test("いちばん大きいモデルが上限を超えるなら、その次に大きいものを勧める", () => {
    const advice = advise({
      speedsOf: (id) => (id === "gemma4:26b" ? SLOW : FAST),
    });
    expect(advice?.fits?.id).toBe("gemma4:12b");
  });

  test("どれも上限を超えるなら、何も出さない", () => {
    expect(advise({ speedsOf: () => SLOW })).toBeUndefined();
  });

  test("上限の判定は1回ごと。全体が長くても、1回が上限内なら勧める", () => {
    // 219話ぶん。全体は何時間にもなるが、1回ずつは上限内
    const advice = advise({ inputChars: new Array(219).fill(18000) });
    expect(advice?.fits?.id).toBe("gemma4:26b");
    expect(advice?.fits?.totalMs).toBeGreaterThan(60 * 60 * 1000);
  });

  test("クラウドのAIでは出さない（手元のモデルの話）", () => {
    expect(advise({ providerId: "gemini" })).toBeUndefined();
    expect(advise({ providerId: "sakura" })).toBeUndefined();
  });

  test("クラウドへ中継するモデル（…-cloud）は勧めない", () => {
    const relay: InstalledModel = { id: "gpt-oss:120b-cloud", parameterSize: "116.8B" };
    const advice = advise({ installed: [E4B, B26, relay] });
    expect(advice?.fits?.id).toBe("gemma4:26b");
  });

  test("いまのモデルの大きさが分からなければ、比べられないので出さない", () => {
    expect(
      advise({ current: { id: "mystery", parameterSize: null } })
    ).toBeUndefined();
  });

  test("大きさの分からないモデルは候補にしない", () => {
    const unknown: InstalledModel = { id: "unknown:latest", parameterSize: null };
    expect(advise({ installed: [E4B, unknown] })).toBeUndefined();
  });

  test("名前ではなく API の大きさで順位を付ける", () => {
    // 名前に数字が無いモデルでも、申告の大きさが大きければ勧める
    const named: InstalledModel = { id: "writer-large", parameterSize: "32B" };
    const advice = advise({ installed: [E4B, B26, named] });
    expect(advice?.fits?.id).toBe("writer-large");
  });
});

describe("速さを測っていない大きいモデル", () => {
  test("時間を作らず、「測る」へ回す", () => {
    const advice = advise({
      installed: [E4B, B26, B31],
      speedsOf: (id) => (id === "gemma4:31b" ? UNMEASURED : FAST),
    });
    expect(advice?.unmeasured?.id).toBe("gemma4:31b");
    // 測ってあるほうは、そのまま勧める
    expect(advice?.fits?.id).toBe("gemma4:26b");
    const text = describeLargerModelAdvice(advice!, {
      count: 3,
      unit: "チャンク",
      featureLabel: "矛盾検知",
    });
    expect(text).toContain("まだ測っていない");
    expect(text).toContain("一度測ってみますか");
    // 未測定のモデルに時間を付けない
    const unmeasuredLine = text
      .split("\n")
      .find((line) => line.startsWith("gemma4:31b"));
    expect(unmeasuredLine).toBeDefined();
    expect(unmeasuredLine).not.toMatch(/≒|およそ|\d+\s*(?:分|時間|秒)/);
  });

  test("測ってあるものが無くても、測る案内だけは出す", () => {
    const advice = advise({ speedsOf: () => UNMEASURED });
    expect(advice?.fits).toBeUndefined();
    expect(advice?.unmeasured?.id).toBe("gemma4:26b");
    expect(largerModelButtons(advice!)).toEqual({
      measureLabel: "gemma4:26b の速さを測る",
    });
  });

  test("読み込みの速さだけでは時間を作らない（書き出しが分からない）", () => {
    const inputOnly: CandidateSpeeds = {
      inputTokensPerSecond: 2000,
      tokensPerChar: 0.8,
      basis: "bundled-max",
    };
    const advice = advise({ speedsOf: () => inputOnly });
    expect(advice?.fits).toBeUndefined();
    expect(advice?.unmeasured?.id).toBe("gemma4:26b");
  });
});

describe("当たりの記録（同梱）", () => {
  test("記録が両方あり、候補のほうが多いときだけ「当たりが多い」と言う", () => {
    const advice = advise();
    const text = describeLargerModelAdvice(advice!, {
      count: 3,
      unit: "チャンク",
      featureLabel: "矛盾検知",
    });
    expect(text).toContain("4/4");
    expect(text).toContain("0/4");
    expect(text).toContain("当たりが多い");
    // 同梱だと分かるように、日付つきで名乗る
    expect(text).toMatch(/同梱の測定（2026-09-20/);
  });

  test("いまのモデルに記録が無ければ、比べずに数字だけを添える", () => {
    const advice = advise({
      feature: "typo",
      promptVersion: "1.1",
    });
    const text = describeLargerModelAdvice(advice!, {
      count: 3,
      unit: "チャンク",
      featureLabel: "誤字脱字",
    });
    expect(text).toContain("8/12");
    expect(text).toContain("測っていません");
    expect(text).not.toContain("当たりが多い");
  });

  test("記録の無いモデルには、当たりについて何も言わない", () => {
    const advice = advise({ installed: [E4B, B31] });
    const text = describeLargerModelAdvice(advice!, {
      count: 3,
      unit: "チャンク",
      featureLabel: "矛盾検知",
    });
    expect(advice?.fits?.id).toBe("gemma4:31b");
    expect(text).not.toContain("当た");
  });

  test("プロンプトの版が変わった記録は使わない（古くなったら黙って使わない）", () => {
    expect(
      accuracyRecordFor({
        feature: "contradiction",
        providerId: "ollama",
        model: "gemma4:26b",
        promptVersion: "1.7",
      })
    ).toBeUndefined();
    const advice = advise({ promptVersion: "1.7" });
    const text = describeLargerModelAdvice(advice!, {
      count: 3,
      unit: "チャンク",
      featureLabel: "矛盾検知",
    });
    expect(text).not.toContain("4/4");
  });

  test("記録が「当たらない」と言う大きいモデルは勧めない（0件当たり）", () => {
    const granite: InstalledModel = { id: "granite4.2:30b", parameterSize: "30B" };
    const advice = advise({
      feature: "typo",
      promptVersion: "1.1",
      installed: [E4B, B26, granite],
    });
    expect(advice?.fits?.id).toBe("gemma4:26b");
  });

  test("記録がいまのモデル以下なら勧めない", () => {
    const records: FeatureAccuracyRecord[] = [
      {
        feature: "proofread",
        providerId: "ollama",
        model: "gemma4:12b",
        hits: 4,
        total: 8,
        promptVersion: "9.9",
        measuredAt: "2026-09-18",
        bench: "台",
      },
      {
        feature: "proofread",
        providerId: "ollama",
        model: "gemma4:26b",
        hits: 4,
        total: 8,
        promptVersion: "9.9",
        measuredAt: "2026-09-20",
        bench: "台",
      },
    ];
    expect(
      advise({
        feature: "proofread",
        promptVersion: "9.9",
        current: B12,
        installed: [B12, B26],
        records,
      })
    ).toBeUndefined();
  });

  test("候補に記録が無ければ、比べる文は空", () => {
    expect(
      describeAccuracyComparison({
        candidateModel: "x",
        candidate: undefined,
        currentModel: "y",
        current: undefined,
      })
    ).toBe("");
  });
});

describe("ボタンと文", () => {
  test("切り替えるボタンは、上限内に終わる見込みのモデルにだけ付く", () => {
    expect(largerModelButtons(advise()!)).toEqual({
      switchLabel: "gemma4:26b に切り替える",
    });
  });

  test("切り替えると割当が変わることを、押す前に言う", () => {
    const text = describeLargerModelAdvice(advise()!, {
      count: 3,
      unit: "チャンク",
      featureLabel: "矛盾検知",
    });
    expect(text).toContain("「矛盾検知」の割当が gemma4:26b になり");
    expect(text).toContain("機能別AI割当");
    expect(text).toContain("これまでの実測から");
  });
});
