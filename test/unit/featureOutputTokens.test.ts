import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspace } from "./support/vscodeStub";
import { tuningStoreContents, useMemoryTuningStore } from "./support/tuningStore";
import {
  resolveOutputLimitForSend,
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../../src/ai/outputLimit";
import {
  FEATURE_OUTPUT_MARGIN,
  MIN_FEATURE_OUTPUT_SAMPLES,
  featureOutputCeiling,
  featureOutputKey,
  recordFeatureOutputTokens,
} from "../../src/core/featureOutputTokens";
import {
  bundledFeatureOutput,
  bundledFeatureOutputKeys,
} from "../../src/core/bundledTuning";

/**
 * 出力に見込むトークン数を、**実測から決める**（作者の裁定、2026-09-19）。
 *
 * ## 何が壊れていたか
 *
 * 計画（`resolveOutputTokensForPlanning`）と関所（`MeteredProvider` の
 * `outputTokensFor`）が、同じ呼び出しについて**別々の値**を持っていた。
 *
 * - 計画……`min(設定16,384, OUTPUT_RESERVE_TOKENS 8,192)` ＝ **8,192**
 * - 関所……上限を送るプロバイダ（さくらなど）では実送信の上限 ＝ **16,384**
 *
 * 計画が関所より 8,192 トークン甘いので、**計画いっぱいに詰めたチャンクが
 * 関所に断られて割られる**のが常態だった。割られた結果、さくらでは第5話の
 * 人物を取り違えている（実機、2026-09-19）。
 *
 * ## 直し方
 *
 * 「この機能は1回の応答で何トークン書くか」を**機能ごとに実測**して覚え、
 * **計画も関所も送る上限も、その1つの出どころから引く**。
 */

const PROVIDER = "sakura";
const MODEL = "preview/gemma-4-31B-it";

beforeEach(async () => {
  // 台帳は保管庫のファイル（`core/modelTuningStore.ts`）。毎回空から始める
  await useMemoryTuningStore({});
});

afterEach(() => {
  workspace.getConfiguration = () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  });
});

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

/** しきい値に届くまで、同じ量を書けたことにする */
async function recordSamples(
  feature: string,
  tokens: number,
  times: number
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await recordFeatureOutputTokens(feature, tokens, false);
  }
}

describe("計画と関所が、同じ出どころから引く", () => {
  it("実測のある機能では、見込みと送る上限が一致する", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("typo_check", 8753, MIN_FEATURE_OUTPUT_SAMPLES);

    const planned = resolveOutputTokensForPlanning(PROVIDER, MODEL, "typo_check");
    const sent = resolveOutputTokensForSend(PROVIDER, MODEL, "typo_check");

    // **ここが本体。** 8,192（計画）と 16,384（関所）に割れていたのをやめる
    expect(planned).toBe(sent);
  });

  it("同梱の初期値しか無い機能でも、見込みと送る上限が一致する", () => {
    installSettings({ maxOutputTokens: 16384 });

    // 同梱表に3回以上の実測がある機能（`core/bundledTuning.ts`）
    const planned = resolveOutputTokensForPlanning(
      PROVIDER,
      MODEL,
      "character_extract"
    );
    const sent = resolveOutputTokensForSend(PROVIDER, MODEL, "character_extract");

    expect(planned).toBe(sent);
    expect(planned).toBeLessThan(16384);
  });

  it("機能を渡さない呼び出しは、これまでどおり（挙動を変えない）", () => {
    installSettings({ maxOutputTokens: 16384 });

    expect(resolveOutputTokensForPlanning(PROVIDER, "測っていないモデル")).toBe(
      8192
    );
    expect(resolveOutputTokensForSend(PROVIDER, "測っていないモデル")).toBe(
      16384
    );
  });
});

describe("実測が貯まると、見込みが変わる", () => {
  it("しきい値に届くまでは、設定値のまま（1回では信じない）", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordFeatureOutputTokens("announce", 3000, false);

    expect(featureOutputCeiling("announce")).toBeUndefined();
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "announce")).toBe(16384);
  });

  it("しきい値に届くと、実測の最大値＋余裕で見込む", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("announce", 3000, MIN_FEATURE_OUTPUT_SAMPLES);

    const ceiling = featureOutputCeiling("announce");
    expect(ceiling).toBeDefined();
    expect(ceiling!).toBeGreaterThanOrEqual(3000 * FEATURE_OUTPUT_MARGIN);
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "announce")).toBe(ceiling);
  });

  it("あとから大きく書いた回があれば、見込みは広がる（最小値ではなく最大値を覚える）", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("announce", 3000, MIN_FEATURE_OUTPUT_SAMPLES);
    const before = featureOutputCeiling("announce")!;

    await recordFeatureOutputTokens("announce", 7000, false);
    const after = featureOutputCeiling("announce")!;

    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThanOrEqual(7000);
  });

  it("切り詰められた回は、要る量の記録にしない（設定値へ戻す）", async () => {
    // 上限で切られた応答の `completion_tokens` は上限そのものなので、
    // 「その機能が要る量」ではない。逆に「上限以上に要る」ことの印である
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("blurb", 4000, MIN_FEATURE_OUTPUT_SAMPLES);
    expect(featureOutputCeiling("blurb")).toBeDefined();

    await recordFeatureOutputTokens("blurb", 16384, true);

    expect(featureOutputCeiling("blurb")).toBeUndefined();
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "blurb")).toBe(16384);
    // 切られた量を「実測」として書き込まない
    const entry = tuningStoreContents()[featureOutputKey("blurb")] as Record<
      string,
      unknown
    >;
    expect(entry.outputTokens).toBe(4000);
  });

  it("作者の実測がある機能では、同梱の初期値を見ない", async () => {
    installSettings({ maxOutputTokens: 16384 });
    // 同梱は 12,023／6回。作者の台帳は 2,000／しきい値ぶん
    await recordSamples("character_extract", 2000, MIN_FEATURE_OUTPUT_SAMPLES);

    const ceiling = featureOutputCeiling("character_extract")!;
    expect(ceiling).toBeLessThan(
      bundledFeatureOutput("character_extract")!.outputTokens
    );
  });
});

describe("実測が無ければ、同梱の初期値", () => {
  it("同梱の実測は、回数がしきい値に届いているものだけを使う", () => {
    installSettings({ maxOutputTokens: 16384 });

    // 6回ぶんの実測がある
    expect(featureOutputCeiling("character_extract")).toBeDefined();
    // 1回しか無い機能は信じない（設定値のまま）
    expect(featureOutputCeiling("chapter_propose")).toBeUndefined();
  });

  it("紹介文（blurb）は同梱しない——切り詰められた回しか無いため", () => {
    // 16,384 は「要った量」ではなく「そこで切られた」量である。
    // 実測として載せると、要る量を知らないまま上限を決めることになる
    expect(bundledFeatureOutput("blurb")).toBeUndefined();
  });

  it("同梱の値は台帳へ書き写さない（読むときだけ混ぜる）", () => {
    installSettings({ maxOutputTokens: 16384 });
    featureOutputCeiling("character_extract");

    expect(tuningStoreContents()[featureOutputKey("character_extract")]).toBe(
      undefined
    );
  });
});

describe("痩せすぎない（見込みを不必要に大きく取らない）", () => {
  it("同梱のどの機能も、実測の最大値を下回らず、設定値を超えない", () => {
    installSettings({ maxOutputTokens: 16384 });

    for (const feature of bundledFeatureOutputKeys()) {
      const seed = bundledFeatureOutput(feature)!;
      const sent = resolveOutputTokensForSend(PROVIDER, MODEL, feature);
      // 実測より小さい上限を送ると、その回は必ず切れて丸ごと捨てられる
      expect(sent, feature).toBeGreaterThanOrEqual(seed.outputTokens);
      // 設定値より大きく確保すると、そのぶんチャンクが痩せる
      expect(sent, feature).toBeLessThanOrEqual(16384);
    }
  });

  it("実測の少ない機能の見込みは、これまでの 8,192 より小さくなる", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("synopsis", 4034, MIN_FEATURE_OUTPUT_SAMPLES);

    // 4,034 × 1.25 ＝ 5,043 → 1,024刻みで 5,120。従来の見込み 8,192 より小さい
    expect(resolveOutputTokensForPlanning(PROVIDER, MODEL, "synopsis")).toBe(
      5120
    );
  });

  it("モデルが書ける量の実測が小さければ、そちらが勝つ", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("character_extract", 12023, MIN_FEATURE_OUTPUT_SAMPLES);
    const { saveModelTuning } = await import("../../src/core/modelTuning");
    await saveModelTuning(PROVIDER, MODEL, { measuredOutputTokens: 6500 });

    expect(
      resolveOutputTokensForPlanning(PROVIDER, MODEL, "character_extract")
    ).toBe(6500);
  });

  it("設定で下げたら、作者の指定が勝つ", async () => {
    installSettings({ maxOutputTokens: 4000 });
    await recordSamples("character_extract", 12023, MIN_FEATURE_OUTPUT_SAMPLES);

    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "character_extract")).toBe(
      4000
    );
  });
});

describe("モデルの表と混ざらない", () => {
  it("機能の行は、モデルの実測一覧に出てこない", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("typo_check", 8753, MIN_FEATURE_OUTPUT_SAMPLES);

    const { allModelTuning } = await import("../../src/core/modelTuning");
    const keys = [...allModelTuning().keys()];

    // 置き場は同じファイルだが、鍵の意味も欄の意味も別物である。
    // 読み飛ばさないと「出力見込み / typo_check」という架空のモデルが並ぶ
    expect(keys).not.toContain(featureOutputKey("typo_check"));
    // 台帳のファイルには、ちゃんと入っている（読み飛ばしが効いているだけ）
    expect(tuningStoreContents()[featureOutputKey("typo_check")]).toBeDefined();
  });
});

describe("切り詰められたときの案内", () => {
  it("機能の実測で絞っていたときは、そう言う", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("synopsis", 4034, MIN_FEATURE_OUTPUT_SAMPLES);

    const limit = resolveOutputLimitForSend(PROVIDER, MODEL, "synopsis");
    expect(limit.source).toBe("機能の実測");
  });
});
