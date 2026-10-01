import { describe, expect, it } from "vitest";
import { summarizeTuningTable } from "../../../src/core/tuningRecordSummary";
import { TUNING_WORK_SAMPLE_VERSION } from "../../../src/core/tuningWorkSample";
import { typoPromptVersion } from "../../../src/prompts/typoCheck";
import { FEATURE_OUTPUT_KEY_PREFIX } from "../../../src/core/featureOutputTokens";
import { TUNING_STORE_FILE } from "../../../src/core/modelTuningStore";

/**
 * AIチューニングの記録（`model-tuning.json`）を MCP へ返す形に要約する
 * （`ai.settings`。作者の裁定、2026-10-01）。
 *
 * 見張るのは：**決めた欄だけ**を返すこと（作者が手で足した欄や、
 * 鍵らしきものは返さない）、機能ごとの出力見込みの行を混ぜないこと、
 * 誤字脱字の精度の目安が古い版の結果なら印が付くこと。
 */

describe("チューニングの記録の要約", () => {
  it("モデルごとに、読める長さ・1000字あたりの秒数・精度の目安・測った日を返す", () => {
    const { records } = summarizeTuningTable({
      "ollama/gemma4:e4b": {
        contextWindow: 131072,
        measuredChars: 91000,
        contextHitCeiling: false,
        contextMeasuredBy: "tokens",
        timeoutSeconds: 300,
        measuredAt: "2026-09-26T06:28:15.000Z",
        workSecondsPer1000Chars: 12.5,
        workFixedSeconds: 3.1,
        workMeasuredAt: "2026-09-26T06:30:00.000Z",
        outputTokensPerSecond: 40.2,
        speedSource: "call",
        speedMeasuredAt: "2026-09-30T00:00:00.000Z",
        charsPerToken: 1.383,
        charsPerTokenSamples: 7,
        typoAccuracyHits: 5,
        typoAccuracyTotal: 7,
        typoAccuracyFalsePositives: 1,
        typoAccuracyWrongFixes: 0,
        typoAccuracyPromptVersion: typoPromptVersion(false),
        typoAccuracySmallPrompt: false,
        typoAccuracySampleVersion: TUNING_WORK_SAMPLE_VERSION,
        typoAccuracyMeasuredAt: "2026-09-26T06:31:00.000Z",
      },
    });
    expect(records).toHaveLength(1);
    const row = records[0];
    expect(row.key).toBe("ollama/gemma4:e4b");
    expect(row.provider).toBe("ollama");
    expect(row.model).toBe("gemma4:e4b");
    expect(row.contextWindow).toBe(131072);
    expect(row.measuredChars).toBe(91000);
    expect(row.timeoutSeconds).toBe(300);
    expect(row.measuredAt).toBe("2026-09-26T06:28:15.000Z");
    expect(row.secondsPer1000Chars).toBe(12.5);
    expect(row.fixedSeconds).toBe(3.1);
    expect(row.workMeasuredAt).toBe("2026-09-26T06:30:00.000Z");
    expect(row.typoAccuracy).toEqual({
      hits: 5,
      total: 7,
      falsePositives: 1,
      wrongFixes: 0,
      smallPrompt: false,
      measuredAt: "2026-09-26T06:31:00.000Z",
      current: true,
    });
    expect(row.cautions).toEqual([]);
  });

  it("精度の目安が古い版の頼み方・文で測ったものなら current: false と印", () => {
    const { records } = summarizeTuningTable({
      "sakura/qwen": {
        typoAccuracyHits: 3,
        typoAccuracyTotal: 7,
        typoAccuracyFalsePositives: 0,
        typoAccuracyWrongFixes: 0,
        typoAccuracyPromptVersion: "古い版",
        typoAccuracySampleVersion: TUNING_WORK_SAMPLE_VERSION,
        typoAccuracyMeasuredAt: "2026-09-20T00:00:00.000Z",
      },
    });
    expect(records[0].typoAccuracy?.current).toBe(false);
    expect(records[0].cautions.join("\n")).toContain("古い");
  });

  it("天井で止まった・分あたりの上限で止まった読める長さには印", () => {
    const { records } = summarizeTuningTable({
      "gemini/g": { measuredChars: 1000, contextHitCeiling: true },
      "gemini/h": { measuredChars: 1000, contextLimitedByRate: true },
    });
    expect(records[0].cautions.join("\n")).toContain("下限");
    expect(records[1].cautions.join("\n")).toContain("上限");
  });

  it("決めた欄のほかは返さない（手で足した欄・鍵らしきもの・サーバーの文）", () => {
    const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const { records } = summarizeTuningTable({
      "openai/gpt": {
        contextWindow: 8000,
        apiKey: secret,
        memo: `鍵は ${secret}`,
        contextDeclared: `maximum context length is 8000 (key ${secret})`,
      },
    });
    const text = JSON.stringify(records);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("memo");
    expect(records[0].contextWindow).toBe(8000);
  });

  it("型の合わない値は、その欄だけ落とす（ほかの欄は読む）", () => {
    const { records } = summarizeTuningTable({
      "ollama/m": { contextWindow: "たくさん", timeoutSeconds: 200, measuredChars: Number.NaN },
    });
    expect(records[0].contextWindow).toBeUndefined();
    expect(records[0].measuredChars).toBeUndefined();
    expect(records[0].timeoutSeconds).toBe(200);
  });

  it("機能ごとの出力見込みの行と、形の崩れた行は記録に混ぜず、数だけ返す", () => {
    const result = summarizeTuningTable({
      [`${FEATURE_OUTPUT_KEY_PREFIX}ollama/m/typo_check`]: { tokens: 300 },
      "ollama/m": { timeoutSeconds: 200 },
      "スラッシュの無い鍵": { timeoutSeconds: 1 },
      "ollama/壊れた行": "文字",
    });
    expect(result.records.map((row) => row.key)).toEqual(["ollama/m"]);
    expect(result.featureOutputRows).toBe(1);
    // 並びは鍵の順
    expect(result.unreadableKeys).toEqual(["ollama/壊れた行", "スラッシュの無い鍵"]);
  });

  it("モデル名に / が入っていても、最初の / でプロバイダと分ける", () => {
    const { records } = summarizeTuningTable({
      "ollama/hf.co/作者/モデル:q4": { timeoutSeconds: 200 },
    });
    expect(records[0].provider).toBe("ollama");
    expect(records[0].model).toBe("hf.co/作者/モデル:q4");
  });

  it("台帳のファイル名は保管庫直下の model-tuning.json", () => {
    expect(TUNING_STORE_FILE).toBe("model-tuning.json");
  });
});
