import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelTuning } from "../../src/core/modelTuning";

/**
 * 出力の速さを、**普段のAI呼び出しから**記録する（作者の裁定、2026-09-06）。
 *
 * 0.36.3 の速度は「書ける量の測定」からしか取れず、あれは手元のAIだけを
 * 測る機能なので、**クラウド（Gemini・さくら・Claude・ChatGPT）は永久に
 * 「—」のまま**だった。関所（`MeteredProvider`）は全プロバイダ・全機能が
 * 通るので、ここで採れば6つとも埋まる。
 *
 * ここで確かめるのは3つ。
 *
 * 1. **速度として使える回だけ採る**——短すぎる応答・失敗・中止・切り詰めは
 *    捨てる（立ち上がりの遅れが支配的で、速さになっていない）
 * 2. **書き込みを抑える**——台帳は設定ファイルなので、呼び出しのたびに
 *    書くとチャンクの数だけファイルへ書くことになる
 * 3. **見積もりだと分かるようにする**——出力トークン数を返さないAIでは
 *    字数からの換算になるので、台帳に出どころを残す
 */

/** 台帳への書き込みを覗く。実物はVS Codeの設定を触るので差し替える */
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
    saveModelTuning: async (
      providerId: string,
      model: string,
      tuning: ModelTuning
    ) => {
      saved.push({ providerId, model, tuning });
    },
  };
});

const { MeteredProvider } = await import("../../src/ai/meteredProvider");
const { AIError } = await import("../../src/ai/types");
const { resetAiSequence } = await import("../../src/core/aiSequence");
const { TOKENS_PER_CHAR } = await import("../../src/core/sizeBudget");
import type {
  AIProvider,
  GenerateParams,
  GenerateResult,
} from "../../src/ai/types";

/** 止めた時計。`Date.now` を差し替えて、テストから進める */
let clockMs = Date.UTC(2026, 8, 6, 3, 0, 0);

function advance(ms: number): void {
  clockMs += ms;
}

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

/** 出力トークン数と所要時間を指定した、うまくいった応答 */
function ok(outputTokens: number, elapsedMs: number): GenerateResult {
  return {
    text: "{}",
    truncated: false,
    elapsedMs,
    usage: { inputTokens: 1_000, outputTokens },
  };
}

function params(overrides: Partial<GenerateParams> = {}): GenerateParams {
  return {
    systemPrompt: "あ".repeat(100),
    userPrompt: "い".repeat(1_000),
    model: "gpt-oss-120b",
    temperature: 0,
    ...overrides,
  };
}

beforeEach(() => {
  saved.length = 0;
  clockMs = Date.UTC(2026, 8, 6, 3, 0, 0);
  vi.spyOn(Date, "now").mockImplementation(() => clockMs);
  resetAiSequence();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("普段の呼び出しから、出力の速さを採る", () => {
  test("十分な長さと時間があれば、トークン/秒を台帳へ書く", async () => {
    const provider = new MeteredProvider(fakeProvider(() => ok(300, 3_000)));

    await provider.generate(params());

    expect(saved).toHaveLength(1);
    expect(saved[0].providerId).toBe("sakura");
    expect(saved[0].model).toBe("gpt-oss-120b");
    expect(saved[0].tuning.outputTokensPerSecond).toBe(100);
    // **出どころを残す。** 「チューニングで測った」のか「普段の呼び出しで
    // たまたま採れた」のかで、値の重みが違う
    expect(saved[0].tuning.speedSource).toBe("call");
    // **チューニングの測定日時と混ぜない。** 別の欄に置く
    expect(saved[0].tuning.speedMeasuredAt).toBe(new Date(clockMs).toISOString());
    expect(saved[0].tuning.measuredAt).toBeUndefined();
  });

  test("短すぎる応答は採らない（立ち上がりの遅れが支配的なので）", async () => {
    const provider = new MeteredProvider(fakeProvider(() => ok(63, 3_000)));

    await provider.generate(params());

    expect(saved).toHaveLength(0);
  });

  test("1秒に満たない応答は採らない", async () => {
    const provider = new MeteredProvider(fakeProvider(() => ok(300, 999)));

    await provider.generate(params());

    expect(saved).toHaveLength(0);
  });

  test("切り詰められた回は採らない", async () => {
    // 途中で切られた応答は「その速さで書き切れた」ことにならない
    const provider = new MeteredProvider(
      fakeProvider(() => ({ ...ok(300, 3_000), truncated: true }))
    );

    await provider.generate(params());

    expect(saved).toHaveLength(0);
  });

  test("失敗した回は採らない", async () => {
    const provider = new MeteredProvider({
      ...fakeProvider(() => ok(300, 3_000)),
      generate: async () => {
        throw new AIError("残高がありません", "insufficient_credit");
      },
    });

    await expect(provider.generate(params())).rejects.toThrow(
      "残高がありません"
    );

    expect(saved).toHaveLength(0);
  });

  test("中止した回は採らない", async () => {
    // 途中で止めた回の所要時間は「書くのにかかった時間」ではない
    const provider = new MeteredProvider({
      ...fakeProvider(() => ok(300, 3_000)),
      generate: async () => {
        throw new AIError("処理が中止されました。", "aborted");
      },
    });

    await expect(provider.generate(params())).rejects.toMatchObject({
      kind: "aborted",
    });

    expect(saved).toHaveLength(0);
  });
});

describe("台帳への書き込みを抑える", () => {
  test("すぐあとの、似た速さは書かない", async () => {
    let elapsed = 3_000;
    const provider = new MeteredProvider(
      fakeProvider(() => ok(300, elapsed))
    );

    await provider.generate(params()); // 100.0 トークン/秒
    advance(30_000);
    elapsed = 3_300; // 90.9 トークン/秒（差は約9%）
    await provider.generate(params());

    expect(saved).toHaveLength(1);
  });

  test("2割以上ちがえば、60秒たっていなくても書く", async () => {
    let elapsed = 3_000;
    const provider = new MeteredProvider(
      fakeProvider(() => ok(300, elapsed))
    );

    await provider.generate(params()); // 100.0
    advance(5_000);
    elapsed = 2_400; // 125.0（差は25%）
    await provider.generate(params());

    expect(saved).toHaveLength(2);
    expect(saved[1].tuning.outputTokensPerSecond).toBe(125);
  });

  test("2割以上ちがっても、書いた直後（5秒未満）は書かない", async () => {
    // チャンクごとに応答の長さが違えば速度は簡単に2割振れる。変化だけを
    // 条件にすると毎回書くことになり、設定ファイルへの書き込みがチャンクの
    // 数だけ走る
    let elapsed = 3_000;
    const provider = new MeteredProvider(
      fakeProvider(() => ok(300, elapsed))
    );

    await provider.generate(params()); // 100.0
    advance(1_000);
    elapsed = 2_400; // 125.0（差は25%）だが、書いた直後
    await provider.generate(params());
    expect(saved).toHaveLength(1);

    advance(4_000); // 合わせて5秒
    await provider.generate(params());
    expect(saved).toHaveLength(2);
  });

  test("60秒たてば、同じ速さでも書き直す", async () => {
    // **平均しない。** 機械の負荷で変わるものなので、いつの値かが
    // 分かるほうがよい（`speedMeasuredAt` を新しくする）
    const provider = new MeteredProvider(fakeProvider(() => ok(300, 3_000)));

    await provider.generate(params());
    advance(60_000);
    await provider.generate(params());

    expect(saved).toHaveLength(2);
    expect(saved[1].tuning.speedMeasuredAt).toBe(
      new Date(clockMs).toISOString()
    );
  });

  test("モデルごとに数える（別のモデルの記録では抑えない）", async () => {
    const provider = new MeteredProvider(fakeProvider(() => ok(300, 3_000)));

    await provider.generate(params({ model: "甲" }));
    advance(1_000);
    await provider.generate(params({ model: "乙" }));

    expect(saved.map((entry) => entry.model)).toEqual(["甲", "乙"]);
  });
});

describe("出力トークン数を返さないAI", () => {
  test("字数から見積もり、推定だと分かるようにする", async () => {
    // 換算は `core/sizeBudget.ts` の係数を借りる（新しい係数を作らない）
    const text = "あ".repeat(700);
    const provider = new MeteredProvider(
      fakeProvider(() => ({ text, truncated: false, elapsedMs: 5_000 }))
    );

    await provider.generate(params());

    const tokens = Math.round(text.length * TOKENS_PER_CHAR);
    expect(saved).toHaveLength(1);
    expect(saved[0].tuning.outputTokensPerSecond).toBe(
      Math.round((tokens / 5) * 10) / 10
    );
    expect(saved[0].tuning.speedSource).toBe("estimated");
  });

  test("見積もりでも短ければ採らない", async () => {
    const provider = new MeteredProvider(
      fakeProvider(() => ({
        text: "あ".repeat(40),
        truncated: false,
        elapsedMs: 5_000,
      }))
    );

    await provider.generate(params());

    expect(saved).toHaveLength(0);
  });

  test("思考の出力も、書いた量として数える", async () => {
    // 思考モードの出力も、そのぶん時間を使って書かれている。
    // 本文だけで見積もると「遅いモデル」に見える
    const provider = new MeteredProvider(
      fakeProvider(() => ({
        text: "あ".repeat(100),
        thinking: "い".repeat(600),
        truncated: false,
        elapsedMs: 5_000,
      }))
    );

    await provider.generate(params());

    const tokens = Math.round(700 * TOKENS_PER_CHAR);
    expect(saved[0].tuning.outputTokensPerSecond).toBe(
      Math.round((tokens / 5) * 10) / 10
    );
  });
});
