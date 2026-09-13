import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelTuning } from "../../src/core/modelTuning";

/**
 * 字↔トークンの換算を、当て推量から実測へ替える（設計書6.77）。
 *
 * 製品は「0.7字/トークン」という安全側の当て推量で見積もっていたが、作者の
 * 送信量の記録（`.aiwriter/logs/usage.md`、437件）で送った字数と応答の
 * `inputTokens` を突き合わせると、**実測はその倍**だった。
 *
 * | モデル | 件数 | 実測（字/トークン） |
 * |---|---|---|
 * | gemma4:12b | 22 | 1.592 |
 * | google/gemma-4-e2b | 26 | 1.578 |
 * | gemma4:26b | 71 | 1.511 |
 * | preview/gemma-4-31B-it | 101 | 1.491 |
 * | google/gemma-4-e4b | 119 | 1.463 |
 * | qwen3:8b | 86 | 1.359 |
 * | gpt-oss-120b | 8 | 1.277（いちばん悪い） |
 * | 全体 | 437 | 1.461 |
 *
 * ここで見るのは5つ。
 *
 * 1. **実測が無ければ、いまと1バイトも同じ**（回帰）
 * 2. 少ない件数では信じない／余白を取る／0.7を下回ったら据え置く
 * 3. **平均ではなく最小値**を覚える（大きい値では上がらない）
 * 4. 測ったことにならない回（キャッシュ・申告なし・短すぎ）を捨てる
 * 5. 実データの値で、チャンクの大きさが実際にいくつになるか
 */

/** 台帳の中身。書き込みを覗きつつ、次の呼び出しがそれを読める形にする */
let ledger: ModelTuning | undefined;
const saved: Array<{
  providerId: string;
  model: string;
  tuning: ModelTuning;
}> = [];

vi.mock("../../src/core/modelTuning", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/core/modelTuning")>();
  return {
    ...actual,
    modelTuning: () => ledger,
    saveModelTuning: async (
      providerId: string,
      model: string,
      tuning: ModelTuning
    ) => {
      saved.push({ providerId, model, tuning });
      // 実物は設定へ書き足す。**次の回が読める**ようにしないと、
      // 最小値を覚えているかどうかが試せない
      ledger = { ...(ledger ?? {}), ...tuning };
    },
  };
});

const {
  CHARS_PER_TOKEN,
  CHARS_PER_TOKEN_MARGIN,
  MIN_CHARS_PER_TOKEN_SAMPLES,
  resolveCharsPerToken,
  resolveTokensPerChar,
  roundCharsPerToken,
  TOKENS_PER_CHAR,
} = await import("../../src/core/sizeBudget");
const { decideChunkSize, planChunkBudget, contextSizeForPrompt } = await import(
  "../../src/core/chunker"
);
const { checkContextFit } = await import("../../src/ai/contextGuard");
const { MeteredProvider } = await import("../../src/ai/meteredProvider");
const { resetAiSequence } = await import("../../src/core/aiSequence");
import type {
  AIProvider,
  GenerateParams,
  GenerateResult,
} from "../../src/ai/types";

/** 5回ぶん採れた、信じてよい台帳 */
function measured(charsPerToken: number, samples = 5): ModelTuning {
  return { charsPerToken, charsPerTokenSamples: samples };
}

describe("実測が無ければ、いまと同じ", () => {
  test("換算はどちらも従来の値を返す", () => {
    expect(resolveCharsPerToken(undefined)).toBe(CHARS_PER_TOKEN);
    expect(resolveCharsPerToken({})).toBe(CHARS_PER_TOKEN);
    // **掛け算の丸めまで同じであること。** `1 / 0.7` と厳密に同じ値でないと、
    // `Math.ceil` の境目で1トークンずれる
    expect(resolveTokensPerChar(undefined)).toBe(TOKENS_PER_CHAR);
    expect(resolveTokensPerChar({})).toBe(TOKENS_PER_CHAR);
  });

  test("壊れた値は読まない（0・負・数でない）", () => {
    expect(resolveCharsPerToken({ charsPerToken: 0, charsPerTokenSamples: 9 })).toBe(
      CHARS_PER_TOKEN
    );
    expect(
      resolveCharsPerToken({ charsPerToken: -1.5, charsPerTokenSamples: 9 })
    ).toBe(CHARS_PER_TOKEN);
    expect(
      resolveCharsPerToken({ charsPerToken: Number.NaN, charsPerTokenSamples: 9 })
    ).toBe(CHARS_PER_TOKEN);
  });

  /**
   * **これが回帰の本体である。** 実測が入るまでは、チャンクの字数も
   * `num_ctx` も関所の判断も、1つも動いてはいけない。
   */
  test("チャンク・num_ctx・関所は、渡さなければ値が動かない", () => {
    for (const contextWindow of [8192, 32768, 131072, 262144]) {
      expect(decideChunkSize(contextWindow, undefined)).toBe(
        decideChunkSize(contextWindow)
      );
    }
    // 共通化の前の実装から手で写した値（`sizeBudget.test.ts` と同じ流儀）
    expect(decideChunkSize(8192)).toBe(2006);
    expect(decideChunkSize(32768)).toBe(8027);
    expect(decideChunkSize(131072)).toBe(20000);

    const budget = planChunkBudget({
      contextWindow: 32768,
      overheadChars: 11000,
      outputTokens: 8192,
      requestedChars: 20000,
    });
    expect(budget).toEqual({ chunkChars: 5638, reason: "shrunk_to_fit" });

    expect(
      contextSizeForPrompt({
        promptChars: 20000,
        outputTokens: 8192,
        contextWindow: 131072,
      })
    ).toBe(40960);

    expect(
      checkContextFit({
        systemChars: 11000,
        userChars: 20000,
        outputTokens: 8192,
        contextWindow: 131072,
      })
    ).toEqual({ needTokens: 52478, fits: true });
  });
});

describe("実測を、そのままは信じない", () => {
  test("5回に満たないうちは使わない", () => {
    for (let samples = 0; samples < MIN_CHARS_PER_TOKEN_SAMPLES; samples++) {
      expect(resolveCharsPerToken(measured(1.461, samples))).toBe(
        CHARS_PER_TOKEN
      );
    }
    expect(
      resolveCharsPerToken(measured(1.461, MIN_CHARS_PER_TOKEN_SAMPLES))
    ).toBeGreaterThan(CHARS_PER_TOKEN);
  });

  test("件数が無い台帳（手で書いたもの）も使わない", () => {
    expect(resolveCharsPerToken({ charsPerToken: 1.461 })).toBe(CHARS_PER_TOKEN);
  });

  test("0.9倍の余白が効く", () => {
    // 実測1.46なら1.314として扱う（測った回と違う内容を送るため）
    expect(resolveCharsPerToken(measured(1.46))).toBeCloseTo(1.314, 10);
    expect(resolveCharsPerToken(measured(1.46))).toBe(
      1.46 * CHARS_PER_TOKEN_MARGIN
    );
  });

  /**
   * **実測のほうが悪いモデルでも、これまでより不利にしない。**
   * 0.7 で動いてきた実績があるので、そこから下げる理由が無い。
   */
  test("0.7を下回ったら0.7を使う", () => {
    // 0.7 / 0.9 = 0.777…。ここが切り替わりの境目
    expect(resolveCharsPerToken(measured(0.5))).toBe(CHARS_PER_TOKEN);
    expect(resolveCharsPerToken(measured(0.7))).toBe(CHARS_PER_TOKEN);
    expect(resolveCharsPerToken(measured(0.777))).toBe(CHARS_PER_TOKEN);
    expect(resolveCharsPerToken(measured(0.78))).toBeGreaterThan(
      CHARS_PER_TOKEN
    );
  });

  test("台帳へ書く値は小数3桁へ切り捨てる", () => {
    // 丸め上げると、実測よりわずかに大きい（危ない側の）値が残る
    expect(roundCharsPerToken(1.4609999)).toBe(1.46);
    expect(roundCharsPerToken(10000 / 6849)).toBe(1.46);
  });
});

/* ------------------------------------------------------------------ *
 * 呼び出しのたびに採る（`ai/meteredProvider.ts`）
 * ------------------------------------------------------------------ */

function fakeProvider(result: () => GenerateResult): AIProvider {
  return {
    id: "sakura",
    displayName: "さくらのAI",
    isPaid: true,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate: async () => result(),
  };
}

/**
 * 応答。**所要時間は1秒未満にしてある**——速度のほうの記録
 * （`MIN_SPEED_SAMPLE_MS`）が動くと、台帳への書き込みが混ざって
 * 何を見ているのか分からなくなる。
 */
function response(usage?: GenerateResult["usage"]): GenerateResult {
  return { text: "{}", truncated: false, elapsedMs: 500, usage };
}

/** 送った字数の合計が `chars` になるプロンプト */
function params(chars: number): GenerateParams {
  return {
    systemPrompt: "あ".repeat(2000),
    userPrompt: "い".repeat(chars - 2000),
    model: "gpt-oss-120b",
    temperature: 0,
  };
}

beforeEach(() => {
  ledger = undefined;
  saved.length = 0;
  resetAiSequence();
});

describe("普段の呼び出しから、字/トークンを採る", () => {
  test("申告があれば、送った字数 ÷ 入力トークン数を台帳へ書く", async () => {
    const provider = new MeteredProvider(
      fakeProvider(() => response({ inputTokens: 6849, outputTokens: 10 }))
    );

    await provider.generate(params(10000));

    expect(saved).toHaveLength(1);
    expect(saved[0].providerId).toBe("sakura");
    expect(saved[0].model).toBe("gpt-oss-120b");
    expect(saved[0].tuning.charsPerToken).toBe(1.46);
    expect(saved[0].tuning.charsPerTokenSamples).toBe(1);
  });

  /**
   * **スキーマの字数は足さない。** プロンプトとは別枠で送られ、入力
   * トークンに乗るかがプロバイダによって違う（`core/usageLog.ts`）。
   */
  test("スキーマを渡しても、分母にも分子にも混ぜない", async () => {
    const provider = new MeteredProvider(
      fakeProvider(() => response({ inputTokens: 6849, outputTokens: 10 }))
    );

    await provider.generate({
      ...params(10000),
      jsonSchema: { type: "object", properties: { あ: { type: "string" } } },
    });

    expect(saved[0].tuning.charsPerToken).toBe(1.46);
  });

  test("最小値を覚える（大きい値が来ても上がらない）", async () => {
    let inputTokens = 6849; // 1.460
    const provider = new MeteredProvider(
      fakeProvider(() => response({ inputTokens, outputTokens: 10 }))
    );

    await provider.generate(params(10000));
    expect(ledger?.charsPerToken).toBe(1.46);

    // 指示やJSONの多い回。字/トークンは大きく出るが、**採らない**
    inputTokens = 5000; // 2.000
    await provider.generate(params(10000));
    expect(ledger?.charsPerToken).toBe(1.46);
    expect(ledger?.charsPerTokenSamples).toBe(2);

    // 本文の詰まった回。小さいほうへは動く
    inputTokens = 8000; // 1.250
    await provider.generate(params(10000));
    expect(ledger?.charsPerToken).toBe(1.25);
    expect(ledger?.charsPerTokenSamples).toBe(3);
  });

  test("件数がそろったあとは、下がった回だけ書く", async () => {
    ledger = measured(1.25, MIN_CHARS_PER_TOKEN_SAMPLES);
    let inputTokens = 5000; // 2.000（上がる側）
    const provider = new MeteredProvider(
      fakeProvider(() => response({ inputTokens, outputTokens: 10 }))
    );

    await provider.generate(params(10000));
    // **設定ファイルへ毎回書かない**（速度の書き込み抑制と同じ理由）
    expect(saved).toHaveLength(0);

    inputTokens = 8500; // 1.176（下がる側）
    await provider.generate(params(10000));
    expect(saved).toHaveLength(1);
    expect(saved[0].tuning.charsPerToken).toBe(1.176);
    expect(saved[0].tuning.charsPerTokenSamples).toBe(6);
  });

  describe("測ったことにならない回は捨てる", () => {
    test("inputTokens を返さないAI", async () => {
      const provider = new MeteredProvider(
        fakeProvider(() => response(undefined))
      );
      await provider.generate(params(10000));
      expect(saved).toHaveLength(0);
      expect(ledger).toBeUndefined();
    });

    test("inputTokens が 0 のAI（Ollama が数えなかった回）", async () => {
      const provider = new MeteredProvider(
        fakeProvider(() => response({ inputTokens: 0, outputTokens: 10 }))
      );
      await provider.generate(params(10000));
      expect(saved).toHaveLength(0);
    });

    /**
     * キャッシュが効いた回は `inputTokens` が実際より小さく出るので、
     * 字/トークンが**実際より大きく**（＝危ない側へ）見える。
     */
    test("キャッシュが効いた回", async () => {
      const provider = new MeteredProvider(
        fakeProvider(() =>
          response({ inputTokens: 3000, outputTokens: 10, cachedInputTokens: 4000 })
        )
      );
      await provider.generate(params(10000));
      expect(saved).toHaveLength(0);
    });

    test("キャッシュに対応していて、効かなかった回（0）は採る", async () => {
      const provider = new MeteredProvider(
        fakeProvider(() =>
          response({ inputTokens: 6849, outputTokens: 10, cachedInputTokens: 0 })
        )
      );
      await provider.generate(params(10000));
      expect(saved).toHaveLength(1);
    });

    /**
     * 短すぎる回。チャット定型文の固定費が支配的になるうえ、最小値を
     * 覚える実装なので、**1度混ざるとその値に張り付いて動かなくなる。**
     */
    test("短すぎる回（接続確認のような数百字）", async () => {
      const provider = new MeteredProvider(
        fakeProvider(() => response({ inputTokens: 120, outputTokens: 10 }))
      );
      await provider.generate({
        ...params(10000),
        systemPrompt: "あ".repeat(50),
        userPrompt: "い".repeat(50),
      });
      expect(saved).toHaveLength(0);
    });
  });
});

/* ------------------------------------------------------------------ *
 * 実データで、大きさがどう変わるか
 * ------------------------------------------------------------------ */

/**
 * **数字が変わったのに、なぜ変わったかが読めないのがいちばん困る。**
 * 実測（1.277〜1.592）が入ったときのチャンク字数を1件ずつ固定しておく。
 */
describe("実データの実測で、チャンクの大きさがどうなるか", () => {
  test.each<[string, number, number]>([
    ["gpt-oss-120b（いちばん悪い）", 1.277, 13180],
    ["qwen3:8b", 1.359, 14026],
    ["google/gemma-4-e4b", 1.463, 15099],
    ["全体の平均", 1.461, 15079],
    ["gemma4:12b（いちばん良い）", 1.592, 16431],
  ])("32kのモデル：%s は 8,027字 → %d字", (_name, ratio, expected) => {
    expect(decideChunkSize(32768)).toBe(8027);
    expect(decideChunkSize(32768, measured(ratio))).toBe(expected);
  });

  /**
   * **作者のモデル（131k）は、もともと頭打ちに当たっている。**
   * `MAX_CHUNK_CHARS`（20,000字）は作者の判断待ちなので触っていない。
   * つまり実測が入っても、チャンクの字数はこれまでと変わらない
   * ——効くのは `num_ctx` と関所のほうである。
   */
  test("131kのモデルは、実測が入っても頭打ちの20,000字のまま", () => {
    expect(decideChunkSize(131072)).toBe(20000);
    for (const ratio of [1.277, 1.461, 1.592]) {
      expect(decideChunkSize(131072, measured(ratio))).toBe(20000);
    }
  });

  test("num_ctx は、実測のぶんだけ小さく確保される", () => {
    const prompt = {
      promptChars: 31000,
      outputTokens: 8192,
      contextWindow: 131072,
    };
    // 当て推量：31,000字を44,286トークンと見る
    expect(contextSizeForPrompt(prompt)).toBe(61440);
    // 実測1.461（余白を取って1.3149）：23,576トークン
    expect(
      contextSizeForPrompt({ ...prompt, measured: measured(1.461) })
    ).toBe(36864);
  });

  test("関所も同じ係数で見る（送る量と判断の前提を割らない）", () => {
    const input = {
      systemChars: 11000,
      userChars: 20000,
      outputTokens: 8192,
      contextWindow: 32768,
    };
    // 当て推量では入らない（52,478 > 32,768）
    expect(checkContextFit(input).fits).toBe(false);
    // 実測なら入る
    const withMeasured = checkContextFit({
      ...input,
      measured: measured(1.461),
    });
    expect(withMeasured.fits).toBe(true);
    expect(withMeasured.needTokens).toBe(31768);
  });
});
