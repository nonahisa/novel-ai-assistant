import { describe, expect, test } from "vitest";
import {
  BUNDLED_FEATURE_ACCURACY,
  describeAccuracyComparison,
  type FeatureAccuracyRecord,
} from "../../../src/core/bundledFeatureAccuracy";

/**
 * 同梱の当たりの記録に、罠に掛かった数を添える（設計書6.102。作者の裁定
 * 2026-10-25 夜、6.102-②）。
 *
 * CLAUDE.md の失敗2「見逃しと誤検出の両方を測る」——当たりだけを画面に添えると、
 * 何でも指摘するモデルが「当たりが多い」に見える。測った記録には罠の結果も持たせ、
 * **欄があるときだけ**文に出す（測っていない罠の数を作らない）。
 */

function record(overrides: Partial<FeatureAccuracyRecord>): FeatureAccuracyRecord {
  return {
    feature: "contradiction",
    providerId: "ollama",
    model: "m",
    hits: 4,
    total: 4,
    promptVersion: "1.6",
    measuredAt: "2026-09-20",
    bench: "答え付きの台（仕込み4）",
    ...overrides,
  };
}

describe("罠に掛かった数を、案内の文に添える", () => {
  test("罠の欄がある記録は、文に罠に掛かった数が出る", () => {
    const text = describeAccuracyComparison({
      candidateModel: "big",
      candidate: record({ model: "big", traps: 4, trapHits: 0 }),
      currentModel: "small",
      current: undefined,
    });
    expect(text).toContain("4/4");
    expect(text).toContain("罠に掛かった数 0/4");
  });

  test("比べる文でも、両方の罠の欄が出る", () => {
    const text = describeAccuracyComparison({
      candidateModel: "big",
      candidate: record({ model: "big", traps: 4, trapHits: 0 }),
      currentModel: "small",
      current: record({ model: "small", hits: 1, traps: 4, trapHits: 2 }),
    });
    expect(text).toContain("当たりが多い側です");
    expect(text).toContain("罠に掛かった数 0/4");
    expect(text).toContain("罠に掛かった数 2/4");
  });

  test("罠の欄が無い記録は、罠に触れない", () => {
    const text = describeAccuracyComparison({
      candidateModel: "big",
      candidate: record({ model: "big" }),
      currentModel: "small",
      current: record({ model: "small", hits: 1 }),
    });
    expect(text).toContain("4/4");
    expect(text).not.toContain("罠");
  });

  test("同梱の記録は、罠の欄を持つなら両方そろえて持ち、掛かった数は罠の数を超えない", () => {
    for (const entry of BUNDLED_FEATURE_ACCURACY) {
      const label = `${entry.feature}/${entry.model}/${entry.promptVersion}`;
      expect(entry.traps === undefined, label).toBe(entry.trapHits === undefined);
      if (entry.traps !== undefined && entry.trapHits !== undefined) {
        expect(entry.traps, label).toBeGreaterThan(0);
        expect(entry.trapHits, label).toBeLessThanOrEqual(entry.traps);
      }
    }
  });
});
