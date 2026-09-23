import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "./support/vscodeStub";
import {
  describeChunkSettings,
  forgetTimeFitMemoryForTests,
  readChunkSettings,
} from "../../src/features/chunkSettings";
import { CHUNK_SIZE_MODE_MANUAL } from "../../src/core/chunker";
import { featureOutputKey, rememberedTimeFitChunkChars } from "../../src/core/featureOutputTokens";
import { tuningStoreContents, useMemoryTuningStore } from "./support/tuningStore";

/**
 * **チャンクの大きさを、待ち時間の上限に収まる大きさにする**——
 * `readChunkSettings` への繋ぎ込み（作者の裁定、2026-09-23。残課題 A8）。
 *
 * 純粋な決め方は `chunkTimeFit.test.ts` が見る。ここで見るのは、
 * 台帳（速さ・待ち時間・書く量）から正しく引いてくること、作者の指定を
 * 黙って変えないこと、選んだ段を台帳へ覚えて次も同じにすること。
 */

const PROVIDER = "ollama";
const MODEL = "gemma4:e2b";
const FEATURE = "character_extract";
const TARGET = { providerId: PROVIDER, model: MODEL, feature: FEATURE };

/** ノートPCの実測（2026-09-23）。待ち時間は台帳の600秒 */
function laptopLedger(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    [`${PROVIDER}/${MODEL}`]: {
      measuredChars: 200000,
      charsPerToken: 1.383,
      charsPerTokenSamples: 5,
      inputTokensPerSecond: 26.7,
      outputTokensPerSecond: 6.3,
      timeoutSeconds: 600,
      ...overrides,
    },
    [featureOutputKey(FEATURE, PROVIDER, MODEL)]: {
      outputTokens: 1000,
      outputTokensAverage: 850,
      outputTokenSamples: 5,
    },
  };
}

function installSettings(values: Record<string, unknown>): void {
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key in values ? values[key] : defaultValue) as T,
      inspect: () => ({ workspaceValue: undefined }),
      update: async (key: string, value: unknown) => {
        values[key] = value;
      },
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
}

const FIXED_COST = { overheadChars: 0, outputTokens: 1000 };

beforeEach(() => {
  forgetTimeFitMemoryForTests();
});

afterEach(() => {
  workspace.getConfiguration = () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  });
});

describe("readChunkSettings は、待ち時間の上限に収まる大きさにする", () => {
  test("手動13,000字でも、ノートPCの速さ・待ち時間600秒なら縮め、そう書く", async () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 13000 });
    await useMemoryTuningStore(laptopLedger());

    const settings = readChunkSettings(131072, FIXED_COST, TARGET);

    expect(settings.chunk.chars).toBe(8000);
    expect(settings.chunkCharsBeforeTimeFit).toBe(13000);
    expect(settings.timeFit?.timeoutSeconds).toBe(600);
    expect(settings.timeFit?.predictedSeconds).toBeLessThanOrEqual(420);
    // **黙って縮めない**——記録に元の字数と理由が出る
    const note = describeChunkSettings(settings);
    expect(note).toContain("待ち時間 600秒の7割");
    expect(note).toContain("13000字から縮小");
    expect(note).toMatch(/見込み 約\d+秒/);
  });

  /** 縮めても収まらないなら、そう言って次の一手を示す（実装ルール5） */
  test("縮めても収まらない見込みなら、記録にそう書く", async () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 13000 });
    await useMemoryTuningStore(laptopLedger({ timeoutSeconds: 180 }));

    const settings = readChunkSettings(
      131072,
      { overheadChars: 11000, outputTokens: 1000 },
      TARGET
    );

    expect(settings.timeFit?.reason).toBe("minimum");
    expect(describeChunkSettings(settings)).toContain("縮めても収まらない見込み");
  });

  test("自動（20,000字）でも同じく縮める", async () => {
    installSettings({});
    await useMemoryTuningStore(laptopLedger());

    const settings = readChunkSettings(131072, FIXED_COST, TARGET);

    expect(settings.chunkCharsBeforeTimeFit).toBe(20000);
    expect(settings.chunk.chars).toBe(8000);
  });

  /** 手元のAIの新しい上限（1800秒）なら、13,000字は526秒の見込みで収まる */
  test("待ち時間1800秒なら、13,000字はそのまま", async () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 13000 });
    await useMemoryTuningStore(laptopLedger({ timeoutSeconds: 1800 }));

    const settings = readChunkSettings(131072, FIXED_COST, TARGET);

    expect(settings.chunk.chars).toBe(13000);
    expect(settings.chunkCharsBeforeTimeFit).toBeUndefined();
    expect(settings.timeFit?.reason).toBe("fits");
  });

  /** **速さが測れていないときは、これまでどおり**（勝手に小さくしない） */
  test("読み込みの速さが台帳に無ければ、変えない", async () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 13000 });
    await useMemoryTuningStore(
      laptopLedger({ inputTokensPerSecond: undefined })
    );

    const settings = readChunkSettings(131072, FIXED_COST, TARGET);

    expect(settings.chunk.chars).toBe(13000);
    expect(settings.chunkCharsBeforeTimeFit).toBeUndefined();
    expect(settings.timeFit).toBeUndefined();
  });

  /** 1回きりの呼び出し（告知文など）は機能名を渡さない＝縮めない */
  test("機能名を渡さない呼び出しは、変えない", async () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 13000 });
    await useMemoryTuningStore(laptopLedger());

    const settings = readChunkSettings(131072, FIXED_COST, {
      providerId: PROVIDER,
      model: MODEL,
    });

    expect(settings.chunk.chars).toBe(13000);
    expect(settings.timeFit).toBeUndefined();
  });

  /** まとめ送信も、縮めたチャンクより大きくはならない */
  test("まとめ送信の上限も、縮めた大きさに揃う", async () => {
    installSettings({});
    await useMemoryTuningStore(laptopLedger());

    const settings = readChunkSettings(131072, FIXED_COST, TARGET);

    expect(settings.mergeChars).toBeLessThanOrEqual(settings.chunk.chars);
  });
});

/**
 * **境目が揺れない**——選んだ段を台帳へ覚え、VS Code を開き直しても
 * （＝この窓の記憶が消えても）同じ段にする。段が動くとチャンクの内容ハッシュが
 * 変わり、処理済みのキャッシュが全部外れる。
 */
describe("選んだ段を台帳へ覚えて、次も同じにする", () => {
  test("開き直して速さが1割速くなっても、前回の段のまま", async () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 13000 });
    await useMemoryTuningStore(laptopLedger());

    const first = readChunkSettings(131072, FIXED_COST, TARGET);
    expect(first.chunk.chars).toBe(8000);
    // 台帳へ書き終わるのを待つ（書き込みは処理を止めないよう後ろで走る）
    await vi.waitFor(() => {
      expect(rememberedTimeFitChunkChars(FEATURE, PROVIDER, MODEL)).toEqual({
        chars: 8000,
        requestedChars: 13000,
      });
    });

    // 開き直した（窓の記憶は消える）。速さは1割速い——前回が無ければ 10,000字に上がる
    const stored = tuningStoreContents();
    forgetTimeFitMemoryForTests();
    await useMemoryTuningStore({
      ...stored,
      [`${PROVIDER}/${MODEL}`]: {
        ...(stored[`${PROVIDER}/${MODEL}`] as Record<string, unknown>),
        inputTokensPerSecond: 26.7 * 1.1,
        outputTokensPerSecond: 6.3 * 1.1,
      },
    });

    const again = readChunkSettings(131072, FIXED_COST, TARGET);
    expect(again.chunk.chars).toBe(8000);
  });

  test("前回の記録が無ければ、同じ速さで 10,000字を選ぶ（上の検査が意味を持つことの確認）", async () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 13000 });
    await useMemoryTuningStore(
      laptopLedger({
        inputTokensPerSecond: 26.7 * 1.1,
        outputTokensPerSecond: 6.3 * 1.1,
      })
    );

    const settings = readChunkSettings(131072, FIXED_COST, TARGET);
    expect(settings.chunk.chars).toBe(10000);
  });

  /** 作者が設定を直したら、前回の段に引き留めない */
  test("望みの字数が変わったら、前回の段は見ない", async () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 7000 });
    await useMemoryTuningStore({
      ...laptopLedger(),
      [featureOutputKey(FEATURE, PROVIDER, MODEL)]: {
        outputTokens: 1000,
        outputTokensAverage: 850,
        outputTokenSamples: 5,
        timeFitChunkChars: 5000,
        timeFitRequestedChars: 13000,
      },
    });

    const settings = readChunkSettings(131072, FIXED_COST, TARGET);
    // 7,000字は収まる（約346秒）。前回の5,000字には引き留めない
    expect(settings.chunk.chars).toBe(7000);
  });

  /** 確認の前の見積もり（固定費を知らない）は、段を覚えない */
  test("固定費を渡さない見積もりは、台帳へ覚えない", async () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 13000 });
    await useMemoryTuningStore(laptopLedger());

    readChunkSettings(131072, undefined, TARGET);
    // 書き込みは後ろで走るので、少し待ってから確かめる
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rememberedTimeFitChunkChars(FEATURE, PROVIDER, MODEL)).toBeUndefined();
  });

  /** 出力量の読み手は、この欄を見ない（出力量の実測の扱いを変えない） */
  test("覚えた段の欄は、出力量の記録を壊さない", async () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 13000 });
    await useMemoryTuningStore(laptopLedger());

    readChunkSettings(131072, FIXED_COST, TARGET);
    await vi.waitFor(() => {
      expect(rememberedTimeFitChunkChars(FEATURE, PROVIDER, MODEL)).toBeDefined();
    });
    const row = tuningStoreContents()[featureOutputKey(FEATURE, PROVIDER, MODEL)];
    expect(row).toMatchObject({
      outputTokens: 1000,
      outputTokensAverage: 850,
      outputTokenSamples: 5,
      timeFitChunkChars: 8000,
      timeFitRequestedChars: 13000,
    });
  });
});
