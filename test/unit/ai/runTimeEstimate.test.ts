import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryTuningStore } from "../support/tuningStore";
// **0.72.0 で `views/progress.ts` から `ai/runTimeEstimate.ts` へ移した。**
// この検査はそのままで、**読む場所だけを差し替えてある**——移設で文言が
// 変わっていないことは、下の期待値がそっくり通ることで示す
import { estimateRunTimeText } from "../../../src/ai/runTimeEstimate";
import { featureOutputKey } from "../../../src/core/featureOutputTokens";
import { modelTuningKey } from "../../../src/core/modelTuning";

/**
 * 押す前の所要時間は、**普段の量（平均）から見積もる**（実機、2026-09-21）。
 *
 * ## 何が起きたか
 *
 * 23話の作品にプロット逸脱検知を10話ぶん掛けたとき、押す前の確認に
 * 「10件 ≒ **およそ15分**（これまでの実測から）」と出た。**実際は39秒**
 * である（23倍の過大）。「15分なら夜に回そう」と判断してもおかしくない差。
 *
 * ## なぜ外したか
 *
 * 1回あたりの出力量の台帳（`core/featureOutputTokens.ts`）が持っているのは
 * 「切り詰められていない回の実測の**最大**」だった。**容量の見積もりには
 * 最大が正しい**——足りなければ応答が切れて、そのチャンクが丸ごと捨てられる。
 * だが**所要時間に最大を使えば、必ず過大になる。**
 *
 * しかも覚える値は最大なので、**使うほど見積もりは伸びる。**放っておいても
 * 直らない。
 *
 * ## 直し方
 *
 * 台帳に**平均**をもう1つ持たせ、**時間の見積もりだけがそれを見る。**
 * 最大の側は1文字も変えない（容量の計算がぶら下がっている）。
 */

const PROVIDER = "sakura";
const MODEL = "preview/gemma-4-31B-it";
/** 1秒に100トークン書く機械、という台帳にしておく（割り算を読みやすくする） */
const TOKENS_PER_SECOND = 100;

/** 速さの台帳だけを入れた状態から始める */
async function withLedger(
  feature: Record<string, unknown> | undefined
): Promise<void> {
  await useMemoryTuningStore({
    [modelTuningKey(PROVIDER, MODEL)]: {
      outputTokensPerSecond: TOKENS_PER_SECOND,
    },
    ...(feature !== undefined
      ? {
          // **出力量の実測もモデルごと**（0.71.6）。速さの台帳と同じ鍵で引く
          [featureOutputKey("deviation_check", PROVIDER, MODEL)]: feature,
        }
      : {}),
  });
}

function runText(): string {
  return estimateRunTimeText({
    providerId: PROVIDER,
    model: MODEL,
    feature: "deviation_check",
    count: 10,
    unit: "話",
  });
}

beforeEach(async () => {
  await withLedger(undefined);
});

describe("所要時間は、平均があれば平均から出す", () => {
  it("平均があるときは、最大ではなく平均から見積もる", async () => {
    // 最大 9,000／平均 3,000。100トークン/秒で10話なら、
    // 平均からは 3,000 ÷ 100 × 10 = 300秒（およそ5分）、
    // 最大からは 9,000 ÷ 100 × 10 = 900秒（およそ15分）になる
    await withLedger({
      outputTokens: 9000,
      outputTokensAverage: 3000,
      outputTokenSamples: 5,
    });

    const text = runText();

    expect(text).toContain("およそ5分");
    expect(text).not.toContain("およそ15分");
    // この機械の実測の普段の量なので、割り引かずに読んでよい
    expect(text).toContain("これまでの実測から");
    expect(text).not.toContain("多め");
  });

  it("平均が無いときは最大へ落ち、多めだと名乗る", async () => {
    await withLedger({ outputTokens: 9000, outputTokenSamples: 5 });

    const text = runText();

    expect(text).toContain("およそ15分");
    // 台帳の実測ではあるが、**最大なので過大**である。割り引けるようにする
    expect(text).toContain("実測");
    expect(text).toContain("多め");
    expect(text).not.toContain("同梱");
  });

  it("平均も件数がしきい値に届くまでは使わない（同梱の目安のまま）", async () => {
    // 1回ぶんの平均は「たまたま短かった回」と区別が付かない
    await withLedger({
      outputTokens: 9000,
      outputTokensAverage: 3000,
      outputTokenSamples: 1,
    });

    const text = runText();

    /*
      1回ぶんの平均からは数字を作らない。**ただし同梱の目安は失わない**
      （0.89.6 の担当の報告 #3）。以前はここで「見当が付きません」と出て
      いた——作者の1件が入った途端、台帳が空のときには出ていた同梱の目安
      まで消えていた。台帳が空のとき（下のテスト）と同じ言い方になる
    */
    expect(text).not.toContain("見当が付きません");
    expect(text).toContain("同梱");
    expect(text).toContain("多め");
    expect(text).not.toContain("これまでの実測から");
  });

  it("速さを一度も測っていないモデルでは、見当が付かないと言う", () => {
    /*
      **当てずっぽうを書かない**（`ai/runTimeEstimate.ts` の断り書き）。
      速さの台帳（`outputTokensPerSecond`）は作者自身の呼び出しからしか
      入らないので、無いということは本当に「この機械でこのモデルを
      動かしたことがない」である。既定値を置くと、当てずっぽうが
      実測の顔をして並ぶ。
    */
    const text = estimateRunTimeText({
      providerId: PROVIDER,
      // 台帳にも同梱表にも行の無いモデル
      model: "まだ測っていないモデル",
      feature: "deviation_check",
      count: 10,
      unit: "話",
    });

    expect(text).toContain("見当が付きません");
    expect(text).not.toContain("およそ");
  });

  it("台帳が空なら同梱の目安。同梱だと分かり、多めだとも言う", () => {
    // 同梱の deviation_check は 9,758／5回（`core/bundledTuning.ts`）
    const text = runText();

    expect(text).toContain("同梱");
    expect(text).toContain("多め");
    expect(text).not.toContain("これまでの実測から");
  });
});
