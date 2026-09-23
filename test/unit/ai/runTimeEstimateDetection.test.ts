import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryTuningStore } from "../support/tuningStore";
import { estimateRunTimeText } from "../../../src/ai/runTimeEstimate";
import { featureOutputKey } from "../../../src/core/featureOutputTokens";
import { modelTuningKey } from "../../../src/core/modelTuning";

/**
 * 検知の確認画面の目安が、**測った速さがあるのに同梱の最大で2時間と出た**
 * （ノートPCの実機、0.76.1、2026-09-23）。
 *
 * ## 何が起きたか
 *
 * たゆたう鉛_確認用・Ollama gemma4:e2b（CPUだけ）で誤字脱字検知を5チャンクに
 * 掛けると、確認画面は「5件 ≒ およそ2時間（同梱の目安から。多めに見ています）」。
 * 台帳には読み込み25.8・書き出し6.7トークン/秒の実測があり、同じ機械の
 * 人物抽出は「これまでの実測から」になっていた。
 *
 * ## なぜ外したか
 *
 * 台帳にあったのは**モデルの速さ**だけで、**誤字脱字が1回に書く量**
 * （`出力見込み/ollama/gemma4:e2b/typo_check`）はまだ無かった。検知の目安
 * （`estimateRunTimeText`）は、そのとき同梱の表の**最大**（8,753トークン）へ
 * 落ちる。6.7トークン/秒で割ると1チャンク22分、5件で約1時間50分——
 * 読み込みの時間を足して「およそ2時間」になっていた。
 *
 * 抽出の目安（`estimateCallsTimeFor`）は、**時間には平均しか使わない**
 * （最大は容量のための値で、時間に使えば必ず過大になる）。検知の側だけが
 * 最大をそのまま1つの数字として出していた。
 *
 * ## 直し方
 *
 * 書く量の平均が無く、読み込みの時間が実測で分かるときは、**読み込みの
 * 時間を下限として言う**。最大しか無ければ、それは長いほうの端として
 * 添えるだけにする（1つの数字として出さない）。
 */

const PROVIDER = "ollama";
const MODEL = "gemma4:e2b";
/** たゆたう鉛_確認用（本文 約2万字）を5チャンクに分けたときの字数 */
const LAPTOP_TYPO_CHUNKS = [4_000, 4_000, 4_000, 4_000, 4_000];

/** ノートPCの台帳（読み込み25.8・書き出し6.7トークン/秒）。誤字脱字の書く量は無い */
async function laptopLedger(
  typoOutput?: Record<string, unknown>
): Promise<void> {
  await useMemoryTuningStore({
    [modelTuningKey(PROVIDER, MODEL)]: {
      inputTokensPerSecond: 25.8,
      outputTokensPerSecond: 6.7,
      speedSource: "call",
      // gemma-4 系の字/トークン（`core/bundledTuning.ts` の冒頭の実測）
      charsPerToken: 1.383,
      charsPerTokenSamples: 5,
    },
    // 人物抽出だけは測れている（「これまでの実測から」と出ていた）
    [featureOutputKey("character_extract", PROVIDER, MODEL)]: {
      outputTokens: 1_600,
      outputTokensAverage: 800,
      outputTokenSamples: 5,
    },
    ...(typoOutput !== undefined
      ? { [featureOutputKey("typo_check", PROVIDER, MODEL)]: typoOutput }
      : {}),
  });
}

function typoText(inputChars?: readonly number[]): string {
  return estimateRunTimeText({
    providerId: PROVIDER,
    model: MODEL,
    feature: "typo_check",
    count: LAPTOP_TYPO_CHUNKS.length,
    inputChars: inputChars ?? LAPTOP_TYPO_CHUNKS,
  });
}

beforeEach(async () => {
  await useMemoryTuningStore({});
});

describe("検知の目安は、測った速さがあれば同梱の最大を1つの数字として出さない", () => {
  it("書く量が未測定でも、読み込みの実測から下限を言う（ノートPCの再現）", async () => {
    await laptopLedger();

    const text = typoText();

    // 直す前は「5件 ≒ およそ2時間（同梱の目安から。多めに見ています）」だった
    expect(text).not.toBe("5件 ≒ およそ2時間（同梱の目安から。多めに見ています）");
    // 読み込みの実測を使っていることを名乗る
    expect(text).toContain("読み込みは実測");
    // 読み込み 20,000字 × (1 ÷ (1.383 × 0.9)) ÷ 25.8 ≒ 623秒 ≒ およそ10分
    expect(text).toContain("およそ10分");
    // 書く量を測っていないことを隠さない
    expect(text).toContain("まだ測っていない");
  });

  it("同梱の最大は、長いほうの端として添えるだけ（多めだと名乗る）", async () => {
    await laptopLedger();

    const text = typoText();

    // 読み込み 約10分 ＋ 8,753 ÷ 6.7 × 5 ≒ 109分 → およそ2時間
    expect(text).toMatch(/およそ10分から2時間ほど/);
    expect(text).toContain("同梱の目安");
    expect(text).toContain("多め");
  });

  it("書く量の平均が測れていれば、抽出と同じく「これまでの実測から」1つの数字で言う", async () => {
    // 誤字脱字が1回に平均300トークン書く機械
    await laptopLedger({
      outputTokens: 900,
      outputTokensAverage: 300,
      outputTokenSamples: 3,
    });

    const text = typoText();

    // 読み込み 約623秒 ＋ 300 ÷ 6.7 × 5 ≒ 224秒 → 約847秒 ≒ およそ15分
    expect(text).toBe("5件 ≒ およそ15分（これまでの実測から）");
  });

  it("最大も同梱も無いモデルでも、読み込みの実測があれば下限だけは言う", async () => {
    await laptopLedger();

    const text = estimateRunTimeText({
      providerId: PROVIDER,
      model: MODEL,
      // 同梱の表にも行の無い機能
      feature: "まだ測っていない機能",
      count: 5,
      inputChars: LAPTOP_TYPO_CHUNKS,
    });

    expect(text).toContain("読み込みだけでおよそ10分");
    expect(text).toContain("これより長くかかります");
  });

  it("読み込みの速さを返さないAI（クラウドなど）は、これまでどおり同梱の最大から多めに言う", async () => {
    await useMemoryTuningStore({
      [modelTuningKey("sakura", "preview/gemma-4-31B-it")]: {
        outputTokensPerSecond: 100,
      },
    });

    const text = estimateRunTimeText({
      providerId: "sakura",
      model: "preview/gemma-4-31B-it",
      feature: "typo_check",
      count: 5,
      inputChars: LAPTOP_TYPO_CHUNKS,
    });

    // 8,753 ÷ 100 × 5 ≒ 438秒 → およそ7分
    expect(text).toBe("5件 ≒ およそ7分（同梱の目安から。多めに見ています）");
  });
});
