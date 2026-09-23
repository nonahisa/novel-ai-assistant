import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryTuningStore } from "./support/tuningStore";
import { estimateCallsTimeFor } from "../../src/ai/runTimeEstimate";
import {
  describeCallTimeEstimate,
  estimateCallsTime,
} from "../../src/core/etaEstimate";
import { featureOutputKey } from "../../src/core/featureOutputTokens";
import { modelTuningKey } from "../../src/core/modelTuning";

/**
 * 押す前の目安が、**CPUだけの機械で15倍ずれた**（ノートPCの実機、2026-09-23、0.75.15）。
 *
 * ## 何が起きたか
 *
 * CPUだけの Ollama（gemma4:e2b）で「資料抽出 → 人物を抽出」を5チャンク
 * （送信 13,054／13,160／9,203／8,999／10,644字）に掛けた。確認画面は
 * 「目安 2 分程度」、**実際は約31分**（各チャンク 228〜526秒）。
 *
 * ## なぜ外したか
 *
 * 目安が「1チャンク20秒」の決め打ちだけで作られていた。CPUだけの機械では
 * **本文の読み込み（25〜28トークン/秒）が時間の大半**で、書き出し（6〜7
 * トークン/秒）より長い。送る量にまったく比例しない数字では当たらない。
 *
 * ## 直し方
 *
 * 目安を1か所（`core/etaEstimate.ts` の `estimateCallsTime`）にまとめ、
 * 「送る量 × 読み込みの速さ ＋ 書く量 × 書き出しの速さ」を足す。
 * **速さが分からないときは、これまでの決め打ちへ落とす**（勝手に遅い値を
 * 仮定しない）。
 */

const PROVIDER = "ollama";
const MODEL = "gemma4:e2b";
/** ノートPCの5チャンクの送信字数（指示と既知の人物を含む、送ったぶんそのもの） */
const LAPTOP_CHUNKS = [13_054, 13_160, 9_203, 8_999, 10_644];
/** 実際にかかった時間（約31分） */
const ACTUAL_MINUTES = 31;
/** これまでの決め打ち（`features/extractCharacters.ts`、1チャンク20秒） */
const OLD_SECONDS_PER_CHUNK = 20;

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** ノートPCの実測に近い台帳（読み込み26・書き出し6.5トークン/秒） */
async function laptopLedger(options: { withInput: boolean }): Promise<void> {
  await useMemoryTuningStore({
    [modelTuningKey(PROVIDER, MODEL)]: {
      outputTokensPerSecond: 6.5,
      speedSource: "call",
      ...(options.withInput ? { inputTokensPerSecond: 26 } : {}),
      // gemma-4 系の字/トークン（`core/bundledTuning.ts` の冒頭の実測）
      charsPerToken: 1.383,
      charsPerTokenSamples: 5,
    },
    // 人物抽出は1回に数百トークン書く（ここでは平均800トークン）
    [featureOutputKey("character_extract", PROVIDER, MODEL)]: {
      outputTokens: 1_600,
      outputTokensAverage: 800,
      outputTokenSamples: 5,
    },
  });
}

beforeEach(async () => {
  await useMemoryTuningStore({});
});

describe("CPUだけの機械でも、目安が実際の時間の桁に入る", () => {
  it("読み込みの速さが分かっていれば、送る量に比例した目安になる", async () => {
    await laptopLedger({ withInput: true });

    const estimate = estimateCallsTimeFor({
      providerId: PROVIDER,
      model: MODEL,
      feature: "character_extract",
      inputChars: LAPTOP_CHUNKS,
      fallbackSecondsPerCall: OLD_SECONDS_PER_CHUNK,
    });

    expect(estimate).toBeDefined();
    const minutes = estimate!.ms / 60_000;
    // **桁が合っていればよい**（半分〜2倍）。作者が決めたいのは
    // 「いま回すか、夜に回すか」であって、正確な秒数ではない
    expect(minutes).toBeGreaterThanOrEqual(ACTUAL_MINUTES / 2);
    expect(minutes).toBeLessThanOrEqual(ACTUAL_MINUTES * 2);
    expect(estimate!.source).toBe("measured");
  });

  it("これまでの決め打ち（1チャンク20秒）では桁が合わない（直す前の姿）", () => {
    const minutes = (LAPTOP_CHUNKS.length * OLD_SECONDS_PER_CHUNK) / 60;
    // 5チャンク × 20秒 ＝ 100秒。実際の31分の1/18しかない
    expect(minutes).toBeLessThan(ACTUAL_MINUTES / 2);
  });

  it("書く量をまだ測っていなければ、読み込みの実測に決め打ちを足す（一部が決め打ちだと名乗る）", async () => {
    await useMemoryTuningStore({
      [modelTuningKey(PROVIDER, MODEL)]: {
        outputTokensPerSecond: 6.5,
        inputTokensPerSecond: 26,
        charsPerToken: 1.383,
        charsPerTokenSamples: 5,
      },
    });

    const estimate = estimateCallsTimeFor({
      providerId: PROVIDER,
      model: MODEL,
      // 人物抽出には同梱の**最大**（12,023トークン）があるが、目安には
      // 使わない。6.5トークン/秒の機械なら1チャンク30分超になり、桁を
      // 逆向きに外す。平均が無ければ「書く量は分からない」として扱う
      feature: "character_extract",
      inputChars: LAPTOP_CHUNKS,
      fallbackSecondsPerCall: OLD_SECONDS_PER_CHUNK,
    });

    expect(estimate?.source).toBe("partial");
    // 読み込みだけでも20分を超える。決め打ちの2分へは落ちない
    expect(estimate!.ms / 60_000).toBeGreaterThan(20);
    expect(describeCallTimeEstimate(estimate!)).toContain("決め打ち");
  });

  it("速さを一度も測っていなければ、これまでの決め打ちへ落ちる（遅い値を仮定しない）", () => {
    const estimate = estimateCallsTimeFor({
      providerId: PROVIDER,
      model: "まだ測っていないモデル",
      feature: "character_extract",
      inputChars: LAPTOP_CHUNKS,
      fallbackSecondsPerCall: OLD_SECONDS_PER_CHUNK,
    });

    expect(estimate).toEqual({
      ms: LAPTOP_CHUNKS.length * OLD_SECONDS_PER_CHUNK * 1000,
      source: "fixed",
    });
    const text = describeCallTimeEstimate(estimate!);
    expect(text).toBe("目安 2 分程度（この機械ではまだ速さを測っていないので、決め打ちの見込みです）");
  });

  it("読み込みの速さを返さないAI（クラウドなど）は、出力の速さだけで見る", async () => {
    // 普段の呼び出しで採れる出力の速さは、応答全体の所要時間から出した
    // もので、読み込みの時間も含んでいる。足し直すと二重に数える
    await laptopLedger({ withInput: false });

    const estimate = estimateCallsTimeFor({
      providerId: PROVIDER,
      model: MODEL,
      feature: "character_extract",
      inputChars: LAPTOP_CHUNKS,
      fallbackSecondsPerCall: OLD_SECONDS_PER_CHUNK,
    });

    // 800 ÷ 6.5 × 5 ≒ 615秒
    expect(estimate?.source).toBe("measured");
    expect(Math.round(estimate!.ms / 1000)).toBe(615);
  });
});

describe("見積もりの式（1か所だけに置く）", () => {
  it("送る量 × 読み込みの速さ ＋ 書く量 × 書き出しの速さ、を回数ぶん足す", () => {
    const estimate = estimateCallsTime({
      inputChars: [1_000, 3_000],
      tokensPerChar: 1,
      inputTokensPerSecond: 100,
      outputTokensPerSecond: 10,
      outputTokensPerCall: 50,
      fallbackSecondsPerCall: 20,
    });

    // 読み込み 4,000 ÷ 100 ＝ 40秒、書き出し 50 ÷ 10 × 2 ＝ 10秒
    expect(estimate).toEqual({ ms: 50_000, source: "measured" });
    expect(sum([1_000, 3_000])).toBe(4_000);
  });

  it("送るものが無ければ数字を作らない", () => {
    expect(
      estimateCallsTime({
        inputChars: [],
        tokensPerChar: 1,
        fallbackSecondsPerCall: 20,
      })
    ).toBeUndefined();
  });

  it("決め打ちも渡されなければ、分からないときは数字を作らない", () => {
    expect(
      estimateCallsTime({ inputChars: [1_000], tokensPerChar: 1 })
    ).toBeUndefined();
    // 読み込みだけ分かっていても、書く側を当てずっぽうで埋めない
    expect(
      estimateCallsTime({
        inputChars: [1_000],
        tokensPerChar: 1,
        inputTokensPerSecond: 100,
      })
    ).toBeUndefined();
  });

  it("壊れた速さは、無いものとして扱う", () => {
    expect(
      estimateCallsTime({
        inputChars: [1_000],
        tokensPerChar: 1,
        inputTokensPerSecond: 0,
        outputTokensPerSecond: Number.NaN,
        outputTokensPerCall: 50,
        fallbackSecondsPerCall: 20,
      })
    ).toEqual({ ms: 20_000, source: "fixed" });
  });

  it("実測から出した目安は、実測からだと名乗る", () => {
    expect(
      describeCallTimeEstimate({ ms: 31 * 60_000, source: "measured" })
    ).toBe("目安 31 分程度（これまでの実測から）");
  });

  it("1時間を超えたら、分を並べず「およそ◯時間」で言う", () => {
    expect(
      describeCallTimeEstimate({ ms: 480 * 60_000, source: "measured" })
    ).toBe("目安 およそ8時間（これまでの実測から）");
    expect(
      describeCallTimeEstimate({ ms: 95 * 60_000, source: "measured" })
    ).toBe("目安 およそ1時間30分（これまでの実測から）");
  });
});
