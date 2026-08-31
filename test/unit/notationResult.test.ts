import { describe, it, expect } from "vitest";
import { describeNotationResult } from "../../src/features/checkNotation";
import type { NotationCheckRunResult } from "../../src/features/checkNotation";
import type { TypoCheckIssue } from "../../src/features/checkTypos";

/**
 * 表記ゆれの完了報告（設計書6.8.9）。
 *
 * **0件のときこそ、理由が要る。** パネルが空のままだと、作者は壊れていると
 * 受け取る。実際に「表記ゆれが提案パネルに出ません」と報告があった
 * （2026-08-21、作者が実機で発見）。
 *
 * 0件になる理由は4つあり、**作者が次に取る手がそれぞれ違う。**
 */

const issue = {
  filePath: "本文/001.txt",
  chunkHash: "notation:001.txt:g1",
  line: 3,
  original: "良い天気",
  target: "良い",
  suggestion: "よい",
  reason: "表記ゆれ",
  confidence: "high",
} as unknown as TypoCheckIssue;

function result(over: Partial<NotationCheckRunResult>): NotationCheckRunResult {
  return {
    issues: [],
    groupCount: 14,
    unifiedCount: 0,
    dismissedCount: 0,
    cancelled: false,
    ...over,
  };
}

describe("指摘が出たとき", () => {
  it("何組を揃えて何件出したかを言う", () => {
    const text = describeNotationResult(
      result({ issues: [issue, issue], unifiedCount: 3, selectedCount: 3 })
    );
    expect(text).toContain("14組");
    expect(text).toContain("3組");
    expect(text).toContain("2件");
  });

  it("無視した分があれば、そう言う", () => {
    const text = describeNotationResult(
      result({ issues: [issue], unifiedCount: 1, dismissedCount: 5 })
    );
    expect(text).toContain("5件");
    expect(text).toContain("無視");
  });

  it("途中で閉じたなら、そこから先を見ていないと言う", () => {
    const text = describeNotationResult(
      result({ issues: [issue], unifiedCount: 1, stoppedEarly: true })
    );
    expect(text).toContain("途中で閉じた");
  });
});

describe("0件のとき、理由を言い分ける", () => {
  it("そもそも表記ゆれが無かった", () => {
    const text = describeNotationResult(result({ groupCount: 0 }));
    expect(text).toContain("見つかりませんでした");
  });

  it("揃える表記を選ぶ前に閉じた", () => {
    // **これが作者の踏んだ道である。** もう一度やればよいと伝える
    const text = describeNotationResult(
      result({ stoppedEarly: true, selectedCount: 14 })
    );
    expect(text).toContain("閉じた");
    expect(text).toContain("もう一度");
  });

  it("すべて「この組は揃えない」を選んだ", () => {
    const text = describeNotationResult(
      result({ selectedCount: 5, unifiedCount: 0 })
    );
    expect(text).toContain("5組");
    expect(text).toContain("揃えない");
  });

  it("全部が「今後直さない」に登録済みだった", () => {
    // 次に取る手が違う（「指摘対象外を管理」から外す）
    const text = describeNotationResult(
      result({ selectedCount: 2, unifiedCount: 2, dismissedCount: 30 })
    );
    expect(text).toContain("30件");
    expect(text).toContain("指摘対象外を管理");
  });

  it("どの理由にも当てはまらなくても、黙らない", () => {
    const text = describeNotationResult(
      result({ selectedCount: 1, unifiedCount: 1 })
    );
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("指摘は作られませんでした");
  });
});
