import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspace } from "../support/vscodeStub";
import { tuningStoreContents, useMemoryTuningStore } from "../support/tuningStore";
import {
  resolveOutputLimitForSend,
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../../../src/ai/outputLimit";
import {
  FEATURE_OUTPUT_MARGIN,
  MIN_FEATURE_OUTPUT_SAMPLES,
  featureOutputCeiling,
  featureOutputKey,
  recordFeatureOutputTokens,
} from "../../../src/core/featureOutputTokens";
import {
  bundledFeatureOutput,
  bundledFeatureOutputKeys,
} from "../../../src/core/bundledTuning";
import { OUTPUT_RESERVE_TOKENS } from "../../../src/ai/contextGuard";
import { lookupCallSpeeds } from "../../../src/ai/runTimeEstimate";

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
  times: number,
  providerId: string = PROVIDER,
  model: string = MODEL
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await recordFeatureOutputTokens(feature, providerId, model, tokens, false);
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
    await recordFeatureOutputTokens("announce", PROVIDER, MODEL, 3000, false);

    expect(featureOutputCeiling("announce", PROVIDER, MODEL)).toBeUndefined();
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "announce")).toBe(16384);
  });

  it("しきい値に届くと、実測の最大値＋余裕で見込む", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("announce", 3000, MIN_FEATURE_OUTPUT_SAMPLES);

    const ceiling = featureOutputCeiling("announce", PROVIDER, MODEL);
    expect(ceiling).toBeDefined();
    expect(ceiling!).toBeGreaterThanOrEqual(3000 * FEATURE_OUTPUT_MARGIN);
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "announce")).toBe(ceiling);
  });

  it("あとから大きく書いた回があれば、見込みは広がる（最小値ではなく最大値を覚える）", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("announce", 3000, MIN_FEATURE_OUTPUT_SAMPLES);
    const before = featureOutputCeiling("announce", PROVIDER, MODEL)!;

    await recordFeatureOutputTokens("announce", PROVIDER, MODEL, 7000, false);
    const after = featureOutputCeiling("announce", PROVIDER, MODEL)!;

    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThanOrEqual(7000);
  });

  it("切り詰められた回は、要る量の記録にしない（設定値へ戻す）", async () => {
    // 上限で切られた応答の `completion_tokens` は上限そのものなので、
    // 「その機能が要る量」ではない。逆に「上限以上に要る」ことの印である
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("blurb", 4000, MIN_FEATURE_OUTPUT_SAMPLES);
    expect(featureOutputCeiling("blurb", PROVIDER, MODEL)).toBeDefined();

    await recordFeatureOutputTokens("blurb", PROVIDER, MODEL, 16384, true);

    expect(featureOutputCeiling("blurb", PROVIDER, MODEL)).toBeUndefined();
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "blurb")).toBe(16384);
    // 切られた量を「実測」として書き込まない
    const entry = tuningStoreContents()[featureOutputKey("blurb", PROVIDER, MODEL)] as Record<
      string,
      unknown
    >;
    expect(entry.outputTokens).toBe(4000);
  });

  it("作者の実測がある機能では、同梱の初期値を見ない", async () => {
    installSettings({ maxOutputTokens: 16384 });
    // 同梱は 12,023／6回。作者の台帳は 2,000／しきい値ぶん
    await recordSamples("character_extract", 2000, MIN_FEATURE_OUTPUT_SAMPLES);

    const ceiling = featureOutputCeiling("character_extract", PROVIDER, MODEL)!;
    expect(ceiling).toBeLessThan(
      bundledFeatureOutput("character_extract")!.outputTokens
    );
  });
});

describe("実測が無ければ、同梱の初期値", () => {
  it("同梱の実測は、回数がしきい値に届いているものだけを使う", () => {
    installSettings({ maxOutputTokens: 16384 });

    // 6回ぶんの実測がある
    expect(featureOutputCeiling("character_extract", PROVIDER, MODEL)).toBeDefined();
    // 1回しか無い機能は信じない（設定値のまま）
    expect(featureOutputCeiling("chapter_propose", PROVIDER, MODEL)).toBeUndefined();
  });

  it("紹介文（blurb）は同梱しない——切り詰められた回しか無いため", () => {
    // 16,384 は「要った量」ではなく「そこで切られた」量である。
    // 実測として載せると、要る量を知らないまま上限を決めることになる
    expect(bundledFeatureOutput("blurb")).toBeUndefined();
  });

  it("同梱の値は台帳へ書き写さない（読むときだけ混ぜる）", () => {
    installSettings({ maxOutputTokens: 16384 });
    featureOutputCeiling("character_extract", PROVIDER, MODEL);

    expect(tuningStoreContents()[featureOutputKey("character_extract", PROVIDER, MODEL)]).toBe(
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
    const { saveModelTuning } = await import("../../../src/core/modelTuning");
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

    const { allModelTuning } = await import("../../../src/core/modelTuning");
    const keys = [...allModelTuning().keys()];

    // 置き場は同じファイルだが、鍵の意味も欄の意味も別物である。
    // 読み飛ばさないと「出力見込み / typo_check」という架空のモデルが並ぶ
    expect(keys).not.toContain(featureOutputKey("typo_check", PROVIDER, MODEL));
    // 台帳のファイルには、ちゃんと入っている（読み飛ばしが効いているだけ）
    expect(tuningStoreContents()[featureOutputKey("typo_check", PROVIDER, MODEL)]).toBeDefined();
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

/**
 * **最大と平均は、用途が違う**（実機、2026-09-21）。
 *
 * プロット逸脱を10話に掛けると「10件 ≒ およそ15分」と出て、**実際は39秒**
 * だった。原因は、**用途の違う2つを1つの数字で兼ねていた**ことである。
 *
 * - **容量**……足りなければ応答が切れて丸ごと捨てられるので、**最大**が正しい
 * - **所要時間**……最大を使えば**必ず過大**になる。要るのは普段の量＝**平均**
 *
 * しかも覚える値が最大なので、**使うほど見積もりは伸びる。**放っておいて
 * 直らない。ここで平均をもう1つ持たせ、時間の見積もりだけがそれを見る。
 */
describe("最大とは別に、平均も覚える", () => {
  /** 台帳のその機能の行（生のまま） */
  function entryOf(feature: string): Record<string, unknown> {
    return tuningStoreContents()[featureOutputKey(feature, PROVIDER, MODEL)] as Record<
      string,
      unknown
    >;
  }

  it("最大は最大のまま、平均は平均になる", async () => {
    await recordFeatureOutputTokens("deviation_check", PROVIDER, MODEL, 100, false);
    await recordFeatureOutputTokens("deviation_check", PROVIDER, MODEL, 200, false);
    await recordFeatureOutputTokens("deviation_check", PROVIDER, MODEL, 900, false);

    const entry = entryOf("deviation_check");
    // 容量の見積もりがぶら下がっているので、最大の決め方は変えない
    expect(entry.outputTokens).toBe(900);
    // 時間の見積もりが見るのはこちら（100・200・900 の平均）
    expect(entry.outputTokensAverage).toBe(400);
    expect(entry.outputTokenSamples).toBe(3);
  });

  it("最大が伸びない回も数える（書き込みの抑制を外す）", async () => {
    // **平均は毎回動く**ので、「改善しないなら書かない」では追随できない。
    // 900 のあと 100 を3回書いても、抑えていた頃は4回目が落ちて
    // 件数が3のまま止まっていた
    await recordFeatureOutputTokens("deviation_check", PROVIDER, MODEL, 900, false);
    for (let i = 0; i < 3; i += 1) {
      await recordFeatureOutputTokens("deviation_check", PROVIDER, MODEL, 100, false);
    }

    const entry = entryOf("deviation_check");
    expect(entry.outputTokenSamples).toBe(4);
    expect(entry.outputTokens).toBe(900);
    expect(entry.outputTokensAverage).toBe(300);
  });

  it("平均を足しても、容量の見積もりは1ミリも変わらない", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordFeatureOutputTokens("announce", PROVIDER, MODEL, 100, false);
    await recordFeatureOutputTokens("announce", PROVIDER, MODEL, 200, false);
    await recordFeatureOutputTokens("announce", PROVIDER, MODEL, 900, false);

    // 平均（400）ではなく**最大（900）**から、余裕と丸めを掛けた値である。
    // ここが平均に倒れると、足りなくて応答が切れる側へ落ちる
    const fromMax =
      Math.ceil((900 * FEATURE_OUTPUT_MARGIN) / 1024) * 1024;
    expect(featureOutputCeiling("announce", PROVIDER, MODEL)).toBe(fromMax);
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "announce")).toBe(fromMax);
  });

  it("切り詰められた回は、平均にも混ぜない", async () => {
    // 切られた回の量は「要った量」ではないので、平均の材料にもならない
    await recordSamples("blurb", 4000, MIN_FEATURE_OUTPUT_SAMPLES);
    await recordFeatureOutputTokens("blurb", PROVIDER, MODEL, 16384, true);

    const entry = entryOf("blurb");
    expect(entry.outputTokensAverage).toBe(4000);
    expect(entry.outputTruncated).toBe(true);
  });
});

/**
 * **仕事の量は、モデルにも依る**（実機、2026-09-21）。
 *
 * ## 何が起きたか
 *
 * さくらのAI（`gpt-oss-120b`）で矛盾検知を10話に掛けたら、**4秒で失敗**した
 * ——「AIから空の応答が返りました」。
 *
 * 台帳を開くと、`出力見込み/contradiction_check` に **714トークン×3回**が
 * 入っていた。この714は**ローカルの `gemma4:26b`（`think: false` ＝ 思考を
 * 吐かない）で測った値**である。それが**思考を吐く推論モデル**の上限
 * （714 × 1.25 → 1,024）として使われ、**思考だけで使い切って本文が空**に
 * なった。
 *
 * ## なぜ起きたか
 *
 * 鍵が機能名だけ（`出力見込み/<機能名>`）で、**どのモデルで測った値なのかを
 * 持っていなかった。** 「仕事の量はモデルに依らない」という前提が、
 * 推論モデルで崩れた——思考のぶんは仕事の大きさではなくモデルの性質である。
 *
 * ## 直し方
 *
 * 鍵に**プロバイダとモデルを足す**（`出力見込み/<プロバイダ>/<モデル>/<機能>`）。
 * チャンクキャッシュの鍵と同じ考え方で、**出どころの違うものを混ぜない。**
 */
describe("モデルの違う実測を混ぜない", () => {
  /** 実機の台帳そのもの。ローカルの、思考を吐かないモデルで測った714 */
  const LOCAL = { providerId: "ollama", model: "gemma4:26b", tokens: 714 };
  /** 失敗したほう。思考を吐く推論モデル */
  const REASONING = { providerId: "sakura", model: "gpt-oss-120b" };

  it("モデルAで測った値が、モデルBの上限にならない（この不具合そのもの）", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples(
      "contradiction_check",
      LOCAL.tokens,
      MIN_FEATURE_OUTPUT_SAMPLES,
      LOCAL.providerId,
      LOCAL.model
    );

    // 714 × 1.25 を 1,024 刻みで切り上げると 1,024。**この値が来てはいけない**
    const ceiling = featureOutputCeiling(
      "contradiction_check",
      REASONING.providerId,
      REASONING.model
    );
    expect(ceiling).not.toBe(1024);
    /*
      同梱の `contradiction_check` は標本2件で `MIN_FEATURE_OUTPUT_SAMPLES`
      （3）に届かないので、受け皿としても効かない。**見込みは既定へ落ちる**
      ——これが「鍵を替えるだけで、この失敗は自然に直る」ということ
    */
    expect(ceiling).toBeUndefined();
    expect(
      resolveOutputTokensForPlanning(
        REASONING.providerId,
        REASONING.model,
        "contradiction_check"
      )
    ).toBe(OUTPUT_RESERVE_TOKENS);
    expect(
      resolveOutputTokensForSend(
        REASONING.providerId,
        REASONING.model,
        "contradiction_check"
      )
    ).toBe(16384);
  });

  it("測ったモデル自身には、これまでどおり効く", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples(
      "contradiction_check",
      LOCAL.tokens,
      MIN_FEATURE_OUTPUT_SAMPLES,
      LOCAL.providerId,
      LOCAL.model
    );

    expect(
      featureOutputCeiling("contradiction_check", LOCAL.providerId, LOCAL.model)
    ).toBe(1024);
  });

  it("同じプロバイダでもモデルが違えば、分かれる", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples(
      "typo_check",
      3000,
      MIN_FEATURE_OUTPUT_SAMPLES,
      "sakura",
      "gpt-oss-120b"
    );

    // 3,000 × 1.25 ＝ 3,750 → 1,024刻みで 4,096
    expect(featureOutputCeiling("typo_check", "sakura", "gpt-oss-120b")).toBe(
      4096
    );
    /*
      **同じさくらでも、別のモデルには効かない。** ただし `typo_check` には
      同梱の受け皿があるので、undefined ではなく**同梱から出た値**へ落ちる
      ——ここが「同梱は機能ごとのまま残す」ということ
    */
    const other = featureOutputCeiling(
      "typo_check",
      "sakura",
      "preview/gemma-4-31B-it"
    );
    expect(other).not.toBe(4096);
    expect(other).toBeGreaterThanOrEqual(
      bundledFeatureOutput("typo_check")!.outputTokens
    );
  });

  it("平均（所要時間の見積もり）も、モデルごとに分かれる", async () => {
    await recordFeatureOutputTokens(
      "deviation_check",
      LOCAL.providerId,
      LOCAL.model,
      1000,
      false
    );

    const mine = tuningStoreContents()[
      featureOutputKey("deviation_check", LOCAL.providerId, LOCAL.model)
    ] as Record<string, unknown>;
    expect(mine.outputTokensAverage).toBe(1000);
    // 別のモデルの行は、そもそも存在しない
    expect(
      tuningStoreContents()[
        featureOutputKey(
          "deviation_check",
          REASONING.providerId,
          REASONING.model
        )
      ]
    ).toBeUndefined();
  });

  it("古い鍵（モデルの無い行）は読まない", async () => {
    installSettings({ maxOutputTokens: 16384 });
    /*
      0.71.5 までの形の行を、そのまま台帳へ置く。**どのモデルで測ったのか
      分からない**ので、読むと今回と同じ事故になる。消す処理は書いていない
      （作者が「AIチューニングの記録を消す」で消せる）
    */
    await useMemoryTuningStore({
      "出力見込み/contradiction_check": {
        outputTokens: 714,
        outputTokensAverage: 714,
        outputTokenSamples: 3,
        measuredAt: "2026-09-20T00:02:40",
      },
    });

    expect(
      featureOutputCeiling("contradiction_check", LOCAL.providerId, LOCAL.model)
    ).toBeUndefined();
    expect(
      featureOutputCeiling(
        "contradiction_check",
        REASONING.providerId,
        REASONING.model
      )
    ).toBeUndefined();
  });

  it("同梱の受け皿は、記録の無いモデルでもこれまでどおり効く", () => {
    installSettings({ maxOutputTokens: 16384 });

    // 同梱の `deviation_check` は 9,758／5回。モデル別には作れないので、
    // どのプロバイダ・どのモデルから引いても同じ値が出る
    const seed = bundledFeatureOutput("deviation_check")!.outputTokens;
    for (const [providerId, model] of [
      [LOCAL.providerId, LOCAL.model],
      [REASONING.providerId, REASONING.model],
    ]) {
      const sent = resolveOutputTokensForSend(
        providerId,
        model,
        "deviation_check"
      );
      expect(sent, `${providerId}/${model}`).toBeGreaterThanOrEqual(seed);
      expect(sent, `${providerId}/${model}`).toBeLessThanOrEqual(16384);
    }
  });
});

/**
 * **まだ信じない回数の実測が、同梱の初期値を隠していた**（0.89.6 の担当の報告 #3）。
 *
 * 0.89.6 で字/トークンの側（`mergeBundledTuning`）に直したのと同じ形の穴が、
 * 出力の見込みの側に残っていた。普段の呼び出しは1回ごとに台帳へ1件積む。
 * 1件目が入った途端、`featureOutputTuning` は作者の行を返して同梱を見なく
 * なる——ところが読む側（`featureOutputCeiling`・`lookupCallSpeeds`）は
 * 3件に満たない実測を信じないので、**同梱した 8,753 も使われず、設定値
 * （16,384）や当て推量（8,192）へ戻っていた。** 同梱の意味が最初の1回で消える。
 *
 * 直し方も同じ：しきい値に届くまでは同梱を返す。**台帳の生の値は消さない**
 * ので、届けば作者の実測に替わる。
 */
describe("まだ信じない回数の実測は、同梱の初期値を隠さない", () => {
  const bundledCeiling = (feature: string): number =>
    Math.ceil(
      (bundledFeatureOutput(feature)!.outputTokens * FEATURE_OUTPUT_MARGIN) / 1024
    ) * 1024;

  it("1回ぶんの実測が入っても、見込みは同梱から出る（この不具合そのもの）", async () => {
    installSettings({ maxOutputTokens: 16384 });
    const before = featureOutputCeiling("typo_check", PROVIDER, MODEL);
    expect(before).toBe(bundledCeiling("typo_check"));

    await recordFeatureOutputTokens("typo_check", PROVIDER, MODEL, 500, false);

    expect(featureOutputCeiling("typo_check", PROVIDER, MODEL)).toBe(before);
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "typo_check")).toBe(before);
    expect(resolveOutputTokensForPlanning(PROVIDER, MODEL, "typo_check")).toBe(before);
  });

  it("台帳の生の値は数え続け、しきい値に届けば作者の実測に替わる", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordSamples("typo_check", 500, MIN_FEATURE_OUTPUT_SAMPLES - 1);
    // 同梱の件数を数え始めにしない（3件に届くのは作者の実測が3回たまったとき）
    const entry = tuningStoreContents()[
      featureOutputKey("typo_check", PROVIDER, MODEL)
    ] as Record<string, unknown>;
    expect(entry.outputTokenSamples).toBe(MIN_FEATURE_OUTPUT_SAMPLES - 1);
    expect(featureOutputCeiling("typo_check", PROVIDER, MODEL)).toBe(
      bundledCeiling("typo_check")
    );

    await recordFeatureOutputTokens("typo_check", PROVIDER, MODEL, 500, false);
    // 500 × 1.25 → 1,024刻みで 1,024
    expect(featureOutputCeiling("typo_check", PROVIDER, MODEL)).toBe(1024);
  });

  it("切り詰められた印は、同梱より強い（要る量を知らないので設定値へ）", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await recordFeatureOutputTokens("typo_check", PROVIDER, MODEL, 16384, true);

    expect(featureOutputCeiling("typo_check", PROVIDER, MODEL)).toBeUndefined();
    expect(resolveOutputTokensForSend(PROVIDER, MODEL, "typo_check")).toBe(16384);
  });

  it("所要時間の見積もりも、1回ぶんの実測で同梱の目安を失わない", async () => {
    await recordFeatureOutputTokens("typo_check", PROVIDER, MODEL, 500, false);

    const speeds = lookupCallSpeeds(PROVIDER, MODEL, "typo_check");
    expect(speeds.basis).toBe("bundled-max");
    expect(speeds.outputTokensPerCall).toBe(
      bundledFeatureOutput("typo_check")!.outputTokens
    );
  });
});
