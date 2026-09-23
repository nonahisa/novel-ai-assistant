import { describe, expect, it } from "vitest";
import {
  describeCallTimeEstimate,
  describeRunTimeRange,
  estimateCallsTime,
  mergeCallTimeEstimates,
} from "../../../src/core/etaEstimate";
import { describeSuiteRunTime } from "../../../src/core/proofreadingSuite";

/**
 * **何を測っていないのかを正しく言う**（ノートPCの実機、0.76.1、2026-09-23）。
 *
 * 読者の反応の助言の確認に「読み込みは実測、**書き出しは**まだ測っていない
 * ので決め打ちの見込みです」と出た。だが台帳には書き出しの速さ
 * （outputTokensPerSecond 6.7）が入っていた。**測っていないのは
 * 「この機能が1回に書く量」のほう**である。
 *
 * 名乗りが出どころ（`partial`／`fixed`）の3通りしか持たず、書く側の
 * 「速さ」と「量」のどちらが欠けたのかを区別していなかった。検知の確認
 * （`describeRunTimeRange`）は既に「1回に書く量はまだ測っていないので」と
 * 言っており、同じ機械・同じ台帳で2つの言い方が並んでいた。
 */

/** ノートPCの台帳（読み込み26・書き出し6.7トークン/秒） */
const LAPTOP = {
  tokensPerChar: 0.72,
  inputTokensPerSecond: 26,
  outputTokensPerSecond: 6.7,
};

describe("書く側で欠けたものを名指しする", () => {
  it("速さは測ってあり、1回に書く量だけが無い（読者の反応の助言で起きた形）", () => {
    const estimate = estimateCallsTime({
      inputChars: [4_000],
      ...LAPTOP,
      fallbackSecondsPerCall: 60,
    });
    expect(estimate?.source).toBe("partial");
    const text = describeCallTimeEstimate(estimate!);
    expect(text).toContain("1回に書く量はまだ測っていないので、決め打ちの見込みです");
    // 実機で出た、事実と違う言い方
    expect(text).not.toContain("書き出しはまだ測っていない");
  });

  it("書く量はあるが、書き出しの速さが無い", () => {
    const estimate = estimateCallsTime({
      inputChars: [4_000],
      tokensPerChar: LAPTOP.tokensPerChar,
      inputTokensPerSecond: LAPTOP.inputTokensPerSecond,
      outputTokensPerCall: 500,
      fallbackSecondsPerCall: 60,
    });
    expect(estimate?.source).toBe("partial");
    const text = describeCallTimeEstimate(estimate!);
    expect(text).toContain("書き出しの速さはまだ測っていないので、決め打ちの見込みです");
    expect(text).not.toContain("1回に書く量");
  });

  it("書く側がどちらも無い", () => {
    const estimate = estimateCallsTime({
      inputChars: [4_000],
      tokensPerChar: LAPTOP.tokensPerChar,
      inputTokensPerSecond: LAPTOP.inputTokensPerSecond,
      fallbackSecondsPerCall: 60,
    });
    expect(describeCallTimeEstimate(estimate!)).toContain(
      "書き出しの速さや1回に書く量をまだ測っていないので、決め打ちの見込みです"
    );
  });

  it("読み込みの速さが無い（クラウド）でも、書き出しの速さがあれば「速さを測っていない」と言わない", () => {
    const estimate = estimateCallsTime({
      inputChars: [4_000],
      tokensPerChar: LAPTOP.tokensPerChar,
      outputTokensPerSecond: 40,
      fallbackSecondsPerCall: 60,
    });
    expect(estimate?.source).toBe("fixed");
    const text = describeCallTimeEstimate(estimate!);
    expect(text).toContain("1回に書く量はまだ測っていないので、決め打ちの見込みです");
    expect(text).not.toContain("速さを測っていない");
  });

  it("何も測っていなければ、これまでどおり「速さを測っていない」", () => {
    const estimate = estimateCallsTime({
      inputChars: [4_000],
      tokensPerChar: LAPTOP.tokensPerChar,
      fallbackSecondsPerCall: 60,
    });
    expect(describeCallTimeEstimate(estimate!)).toBe(
      "目安 1 分程度（この機械ではまだ速さを測っていないので、決め打ちの見込みです）"
    );
  });
});

describe("同じ台帳なら、どの確認画面でも同じ言い方になる", () => {
  it("抽出・あらすじ・助言の言い方と、検知の言い方が同じ語で「1回に書く量」を名指す", () => {
    const estimate = estimateCallsTime({
      inputChars: [4_000],
      ...LAPTOP,
      fallbackSecondsPerCall: 60,
    });
    const single = describeCallTimeEstimate(estimate!);
    const detect = describeRunTimeRange({ count: 1, readMs: 120_000 });
    const phrase = "1回に書く量はまだ測っていないので";
    expect(single).toContain(phrase);
    expect(detect).toContain(phrase);
    // どちらも読み込みは実測から、と言う
    expect(single).toContain("読み込みは実測から");
    expect(detect).toContain("読み込みは実測から");
  });

  it("まとめ実行（機能ごとの平均）でも、欠けたものを持ち越す", () => {
    const merged = mergeCallTimeEstimates([
      { ms: 60_000, source: "partial", unmeasured: "amount" },
      { ms: 30_000, source: "measured" },
    ]);
    expect(merged?.source).toBe("partial");
    expect(merged?.unmeasured).toBe("amount");
    const text = describeSuiteRunTime(2, {
      totalChars: 10_000,
      chunkCount: 2,
      providerNames: ["Ollama"],
      isPaid: false,
      chunkTime: merged,
    });
    expect(text).toContain("1回に書く量はまだ測っていないので");
  });

  it("機能ごとに欠けたものが違えば、どちらとも言い切らない", () => {
    const merged = mergeCallTimeEstimates([
      { ms: 60_000, source: "partial", unmeasured: "amount" },
      { ms: 30_000, source: "partial", unmeasured: "speed" },
    ]);
    expect(merged?.unmeasured).toBe("both");
    expect(describeCallTimeEstimate(merged!)).toContain(
      "書き出しの速さや1回に書く量をまだ測っていないので"
    );
  });

  it("すべて実測なら、欠けたものを持たない", () => {
    const merged = mergeCallTimeEstimates([
      { ms: 60_000, source: "measured" },
      { ms: 30_000, source: "measured" },
    ]);
    expect(merged).toEqual({ ms: 45_000, source: "measured" });
  });
});
