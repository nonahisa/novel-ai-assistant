import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { workspace } from "./support/vscodeStub";
import {
  describeChunkSettings,
  forgetTimeFitMemoryForTests,
  readChunkSettings,
} from "../../src/features/chunkSettings";
import { CHUNK_SIZE_MODE_MANUAL, planChunkBudget } from "../../src/core/chunker";
import {
  featureOutputKey,
  rememberedTimeFitChunkChars,
} from "../../src/core/featureOutputTokens";
import { useMemoryTuningStore } from "./support/tuningStore";

/**
 * **まるごと読む**ときの大きさ（作者の裁定 A3⑤、2026-09-23。設計書6.10.7）。
 *
 * 分けて読む矛盾検知はそのまま残し、並ぶ別の選択肢として「まるごと」を足す。
 * 区切りは**文脈長と出力の上限**（と、手元の遅い機械では待ち時間の上限）から
 * 決める。見ること：
 * - 分けて読むときの天井（20,000字・作者の字数指定・未チューニングの6,000字）に縛られない
 * - それでも文脈長・書ける量・待ち時間の上限は超えない
 * - まるごと読む回の段を覚えない（分けて読む側のキャッシュを外さない）
 */

const PROVIDER = "ollama";
const MODEL = "gemma4:26b";
const FEATURE = "contradiction_check";
const TARGET = { providerId: PROVIDER, model: MODEL, feature: FEATURE };
const FIXED_COST = { overheadChars: 5000, outputTokens: 10000 };
const WHOLE = { wholeRead: true } as const;

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

beforeEach(() => {
  forgetTimeFitMemoryForTests();
});

afterEach(() => {
  workspace.getConfiguration = () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  });
});

describe("まるごと読むときの1回の大きさ", () => {
  test("文脈長から指示・資料・出力を引いた残り全部を使う（20,000字で止めない）", async () => {
    installSettings({});
    await useMemoryTuningStore({});

    const settings = readChunkSettings(131072, FIXED_COST, TARGET, WHOLE);
    const fits = planChunkBudget({
      contextWindow: 131072,
      overheadChars: FIXED_COST.overheadChars,
      outputTokens: FIXED_COST.outputTokens,
      requestedChars: Number.MAX_SAFE_INTEGER,
    }).chunkChars;

    expect(settings.chunk.chars).toBe(fits);
    expect(settings.chunk.chars).toBeGreaterThan(20000);
    // 未チューニングの安全既定（6,000字）で切らない
    expect(settings.chunkCharsBeforeUntunedCap).toBeUndefined();
    // 話をまたいで詰める
    expect(settings.mergeChars).toBe(settings.chunk.chars);
    expect(settings.wholeRead).toBe(true);
  });

  test("分けて読むときは、これまでどおり（未チューニングなら6,000字）", async () => {
    installSettings({});
    await useMemoryTuningStore({});

    const settings = readChunkSettings(131072, FIXED_COST, TARGET);

    expect(settings.chunk.chars).toBe(6000);
    expect(settings.wholeRead).toBeUndefined();
  });

  test("作者の字数指定（分けて読むためのもの）には縛られない", async () => {
    installSettings({
      chunkSizeMode: CHUNK_SIZE_MODE_MANUAL,
      chunkChars: 3000,
      mergeChunkChars: 3000,
    });
    await useMemoryTuningStore({});

    const settings = readChunkSettings(131072, FIXED_COST, TARGET, WHOLE);

    expect(settings.chunk.chars).toBeGreaterThan(20000);
    expect(settings.mergeChars).toBe(settings.chunk.chars);
  });

  test("文脈長の小さいモデルでは、そのぶん小さく区切る", async () => {
    installSettings({});
    await useMemoryTuningStore({});

    const small = readChunkSettings(32768, FIXED_COST, TARGET, WHOLE);
    const large = readChunkSettings(131072, FIXED_COST, TARGET, WHOLE);

    expect(small.chunk.chars).toBeLessThan(large.chunk.chars);
    expect(small.chunk.chars).toBeGreaterThan(0);
  });

  test("書ける量の実測があれば、出力の上限から区切る", async () => {
    installSettings({});
    await useMemoryTuningStore({
      [`${PROVIDER}/${MODEL}`]: {
        measuredChars: 200000,
        measuredOutputTokens: 8000,
      },
    });

    const settings = readChunkSettings(131072, FIXED_COST, TARGET, WHOLE);

    // 8,000トークン × 0.8 ÷ 0.3（`capMergeCharsByOutputTokens`）
    expect(settings.mergeChars).toBe(Math.floor((8000 * 0.8) / 0.3));
    expect(settings.mergeChars).toBeLessThan(settings.chunk.chars);
  });

  test("手元の遅い機械では、待ち時間の上限からも区切る", async () => {
    installSettings({});
    await useMemoryTuningStore({
      [`${PROVIDER}/${MODEL}`]: {
        measuredChars: 200000,
        charsPerToken: 1.383,
        charsPerTokenSamples: 5,
        inputTokensPerSecond: 26.7,
        outputTokensPerSecond: 6.3,
        timeoutSeconds: 1800,
      },
      [featureOutputKey(FEATURE, PROVIDER, MODEL)]: {
        outputTokens: 1000,
        outputTokensAverage: 850,
        outputTokenSamples: 5,
      },
    });

    const settings = readChunkSettings(131072, FIXED_COST, TARGET, WHOLE);

    expect(settings.timeFit).toBeDefined();
    expect(settings.timeFit!.predictedSeconds).toBeLessThanOrEqual(1800);
    expect(settings.chunkCharsBeforeTimeFit).toBeGreaterThan(settings.chunk.chars);
  });

  test("まるごと読む回の段は覚えない（分けて読む側のキャッシュを外さない）", async () => {
    installSettings({});
    await useMemoryTuningStore({
      [`${PROVIDER}/${MODEL}`]: {
        measuredChars: 200000,
        inputTokensPerSecond: 26.7,
        outputTokensPerSecond: 6.3,
        timeoutSeconds: 1800,
      },
    });

    readChunkSettings(131072, FIXED_COST, TARGET, WHOLE);
    // 書き込みは後ろで走るので、少し待ってから確かめる
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rememberedTimeFitChunkChars(FEATURE, PROVIDER, MODEL)).toBeUndefined();
  });

  test("記録には「まるごと」と出す（分けて読むときと桁が違うので黙らない）", async () => {
    installSettings({});
    await useMemoryTuningStore({});

    const note = describeChunkSettings(
      readChunkSettings(131072, FIXED_COST, TARGET, WHOLE)
    );
    expect(note).toContain("まるごと読む");
  });
});
