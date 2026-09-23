import { describe, expect, test } from "vitest";
import {
  CHUNK_TIME_FIT_RATIO,
  CHUNK_TIME_GROW_RATIO,
  CHUNK_TIME_LADDER,
  CHUNK_TIME_SHRINK_RATIO,
  fitChunkCharsToTimeout,
  predictChunkSeconds,
  type ChunkTimeSpeeds,
} from "../../../src/core/chunkTimeFit";
import { MIN_CHUNK_CHARS } from "../../../src/core/chunker";
import { estimateCallsTime } from "../../../src/core/etaEstimate";

/**
 * **チャンクの大きさを、測った速さから待ち時間の上限に収まる大きさにする**
 * （作者の裁定、2026-09-23。残課題 A8）。
 *
 * CPUだけのノートPC（gemma4:e2b。読み込み約26.7・書き出し約6.3トークン/秒）
 * では、抽出の13,000字のチャンクが526秒かかった。600秒の上限まで74秒しか
 * 無く、少し重い回が来れば切れる。
 */

/** ノートPCの実測（gemma-4 の字/トークン 1.383 に、1割の余白を掛けた換算） */
const LAPTOP: ChunkTimeSpeeds = {
  inputTokensPerSecond: 26.7,
  outputTokensPerSecond: 6.3,
  /*
    1回に書く量の平均。13,000字で526秒という実測から逆算した値
    （読み込み 13,000 × 0.803 ÷ 26.7 ≒ 391秒、残り約135秒 × 6.3 ≒ 850トークン）
  */
  outputTokensPerCall: 850,
  tokensPerChar: 1 / (1.383 * 0.9),
};

describe("1チャンクの所要時間の見込み", () => {
  /** **式の写しを作らない**——確認画面の目安と同じ数字になること */
  test("確認画面の目安（estimateCallsTime）と同じ式で見込む", () => {
    const seconds = predictChunkSeconds(13000, 2000, LAPTOP);
    const eta = estimateCallsTime({
      inputChars: [13000 + 2000],
      tokensPerChar: LAPTOP.tokensPerChar,
      inputTokensPerSecond: LAPTOP.inputTokensPerSecond,
      outputTokensPerSecond: LAPTOP.outputTokensPerSecond,
      outputTokensPerCall: LAPTOP.outputTokensPerCall,
    });
    expect(eta?.source).toBe("measured");
    expect(seconds).toBeCloseTo((eta?.ms ?? 0) / 1000, 6);
  });

  test("ノートPCで13,000字は約526秒（実機と同じ桁）", () => {
    const seconds = predictChunkSeconds(13000, 0, LAPTOP) ?? 0;
    expect(seconds).toBeGreaterThan(500);
    expect(seconds).toBeLessThan(550);
  });

  /** 書く量が測れていなければ、読み込みだけで見る（当て推量で足さない） */
  test("書く量が分からなければ、読み込みの時間だけ", () => {
    const seconds = predictChunkSeconds(13000, 0, {
      ...LAPTOP,
      outputTokensPerCall: undefined,
    });
    expect(seconds).toBeCloseTo((13000 * LAPTOP.tokensPerChar) / 26.7, 6);
  });

  test("読み込みの速さが分からなければ、見込まない", () => {
    expect(
      predictChunkSeconds(13000, 0, { ...LAPTOP, inputTokensPerSecond: undefined })
    ).toBeUndefined();
  });
});

describe("待ち時間の上限に収まる大きさ", () => {
  test("ノートPCの速さ・上限600秒なら、13,000字は上限の7割に収まる大きさへ小さくなる", () => {
    const fit = fitChunkCharsToTimeout({
      requestedChars: 13000,
      timeoutSeconds: 600,
      overheadChars: 0,
      speeds: LAPTOP,
    });
    expect(fit).toBeDefined();
    expect(fit!.chars).toBeLessThan(13000);
    // 収まる
    expect(predictChunkSeconds(fit!.chars, 0, LAPTOP)!).toBeLessThanOrEqual(
      600 * CHUNK_TIME_FIT_RATIO
    );
    // **縮めすぎない**——1段上は収まらない
    const above = CHUNK_TIME_LADDER.filter((r) => r > fit!.chars && r < 13000);
    const next = above[above.length - 1] ?? 13000;
    expect(predictChunkSeconds(next, 0, LAPTOP)!).toBeGreaterThan(
      600 * CHUNK_TIME_FIT_RATIO
    );
    expect(fit!.chars).toBe(8000);
    expect(fit!.reason).toBe("shrunk");
  });

  test("上限1800秒（手元のAIの新しい上限）なら、13,000字はそのまま", () => {
    const fit = fitChunkCharsToTimeout({
      requestedChars: 13000,
      timeoutSeconds: 1800,
      overheadChars: 0,
      speeds: LAPTOP,
    });
    expect(fit!.chars).toBe(13000);
    expect(fit!.reason).toBe("fits");
  });

  /** 指示や資料（毎回送る固定費）の読み込みも、1回の時間に入る */
  test("指示や資料の分も読み込みに数える", () => {
    const light = fitChunkCharsToTimeout({
      requestedChars: 20000,
      timeoutSeconds: 1200,
      overheadChars: 0,
      speeds: LAPTOP,
    });
    const heavy = fitChunkCharsToTimeout({
      requestedChars: 20000,
      timeoutSeconds: 1200,
      overheadChars: 11000,
      speeds: LAPTOP,
    });
    expect(heavy!.chars).toBeLessThan(light!.chars);
  });

  /** **速さが測れていないときは、これまでどおり**（勝手に小さくしない） */
  test("読み込みの速さが無ければ、何も決めない", () => {
    expect(
      fitChunkCharsToTimeout({
        requestedChars: 13000,
        timeoutSeconds: 600,
        overheadChars: 0,
        speeds: { ...LAPTOP, inputTokensPerSecond: undefined },
      })
    ).toBeUndefined();
  });

  test("待ち時間が壊れていれば、何も決めない", () => {
    for (const timeoutSeconds of [0, -1, Number.NaN]) {
      expect(
        fitChunkCharsToTimeout({
          requestedChars: 13000,
          timeoutSeconds,
          overheadChars: 0,
          speeds: LAPTOP,
        }),
        String(timeoutSeconds)
      ).toBeUndefined();
    }
  });

  /** 下限より小さくはしない。縮めても収まらないなら、そう言う */
  test("縮めても収まらないなら、下限で止めて「収まらない見込み」と言う", () => {
    const fit = fitChunkCharsToTimeout({
      requestedChars: 13000,
      timeoutSeconds: 180,
      overheadChars: 11000,
      speeds: LAPTOP,
    });
    expect(fit!.chars).toBe(MIN_CHUNK_CHARS);
    expect(fit!.reason).toBe("minimum");
  });

  /** 作者が下限より小さく指定しているなら、下限へ「上げ」ない */
  test("望みの字数より大きくはしない", () => {
    const fit = fitChunkCharsToTimeout({
      requestedChars: 1000,
      timeoutSeconds: 180,
      overheadChars: 11000,
      speeds: LAPTOP,
    });
    expect(fit!.chars).toBe(1000);
  });

  test("段は、望みの字数より小さいものだけ", () => {
    const fit = fitChunkCharsToTimeout({
      requestedChars: 7000,
      timeoutSeconds: 600,
      overheadChars: 0,
      speeds: LAPTOP,
    });
    // 7,000字は 0.7×600＝420秒に収まる（約346秒）ので、そのまま
    expect(fit!.chars).toBe(7000);
  });
});

/**
 * **境目が揺れないこと**（キャッシュを守るため）。
 *
 * チャンクの大きさが変わると、チャンクの内容ハッシュが総入れ替えになり、
 * 処理済みのキャッシュが全部外れる。速さは「直近の実測」をそのまま持つので
 * 呼ぶたびに少しずつ揺れる——揺れるたびに全部やり直しでは困る。
 */
describe("速さが少し揺れても、境目は動かない", () => {
  const base = {
    requestedChars: 13000,
    timeoutSeconds: 600,
    overheadChars: 0,
  };

  function scaled(factor: number): ChunkTimeSpeeds {
    return {
      ...LAPTOP,
      inputTokensPerSecond: LAPTOP.inputTokensPerSecond! * factor,
      outputTokensPerSecond: LAPTOP.outputTokensPerSecond! * factor,
    };
  }

  test("前回の大きさがあれば、速さが±10%揺れても変えない", () => {
    const first = fitChunkCharsToTimeout({ ...base, speeds: LAPTOP });
    expect(first!.chars).toBe(8000);
    for (const factor of [0.9, 0.93, 0.97, 1.03, 1.07, 1.1]) {
      const again = fitChunkCharsToTimeout({
        ...base,
        speeds: scaled(factor),
        previousChars: first!.chars,
      });
      expect(again!.chars, `×${factor}`).toBe(8000);
    }
  });

  /**
   * 前回の記録が無くても、**段が粗い**ので、ほとんどの揺れでは同じ段に落ちる。
   * 境目の真上にいるときだけは動きうる——そのための前回の記録である。
   */
  test("前回が無くても、段の中ほどなら同じ段に落ちる", () => {
    for (const factor of [0.97, 1.0, 1.03]) {
      const fit = fitChunkCharsToTimeout({ ...base, speeds: scaled(factor) });
      expect(fit!.chars, `×${factor}`).toBe(8000);
    }
  });

  test("前回の大きさが危ない（上限の8割を超える）なら、縮め直す", () => {
    // 速さが半分になった——8,000字では 0.8×600 を超える
    const slow = scaled(0.5);
    expect(predictChunkSeconds(8000, 0, slow)!).toBeGreaterThan(
      600 * CHUNK_TIME_SHRINK_RATIO
    );
    const fit = fitChunkCharsToTimeout({
      ...base,
      speeds: slow,
      previousChars: 8000,
    });
    expect(fit!.chars).toBeLessThan(8000);
    expect(predictChunkSeconds(fit!.chars, 0, slow)!).toBeLessThanOrEqual(
      600 * CHUNK_TIME_FIT_RATIO
    );
  });

  test("1段上が楽に収まる（上限の6割以下）ほど速くなったら、広げ直す", () => {
    const fast = scaled(2);
    expect(predictChunkSeconds(10000, 0, fast)!).toBeLessThanOrEqual(
      600 * CHUNK_TIME_GROW_RATIO
    );
    const fit = fitChunkCharsToTimeout({
      ...base,
      speeds: fast,
      previousChars: 8000,
    });
    expect(fit!.chars).toBeGreaterThan(8000);
  });

  /** 望みの字数が変わった（設定を直した等）なら、前回の段は見ない */
  test("前回の大きさが今回の候補に無ければ、新しく選ぶ", () => {
    const fit = fitChunkCharsToTimeout({
      ...base,
      speeds: LAPTOP,
      previousChars: 7777,
    });
    expect(fit!.chars).toBe(8000);
  });
});
