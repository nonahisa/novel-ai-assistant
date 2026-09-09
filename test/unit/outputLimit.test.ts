import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { workspace } from "./support/vscodeStub";
import {
  MINIMUM_OUTPUT_TOKENS,
  resolveOutputLimitForSend,
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
  truncatedOutputAdvice,
} from "../../src/ai/outputLimit";
import { saveModelTuning } from "../../src/core/modelTuning";
import { readChunkSettings } from "../../src/features/chunkSettings";

/**
 * チャンク予算・num_ctx の確保に見込む出力トークン数（設計書6.65.16の2）。
 *
 * 作者の依頼（2026-09-03）「非力なマシンのローカルLLMでも動く程度に」。
 * 台帳に書ける量の実測（`measuredOutputTokens`）が無いモデルで、既定の
 * `maxOutputTokens`（16,384）をそのまま見込むと、非力なマシンでは
 * 要らないぶんまで num_ctx として確保してしまう。実測があれば
 * `min(設定, 実測)`、無ければ `min(設定, 8,192)` に抑える。
 */

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

describe("resolveOutputTokensForPlanning", () => {
  afterEach(() => {
    // 既定へ戻す。他のテストファイルと共有の作り物なので、差し替えたままに
    // すると後続のテストに影響する
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  it("台帳に実測が無ければ、設定と8,192の小さいほう", async () => {
    installSettings({ maxOutputTokens: 16384 });

    expect(
      resolveOutputTokensForPlanning("ollama", "測っていないモデル")
    ).toBe(8192);
  });

  it("設定が8,192より小さければ、設定のほうを使う", async () => {
    installSettings({ maxOutputTokens: 4000 });

    expect(
      resolveOutputTokensForPlanning("ollama", "測っていないモデル")
    ).toBe(4000);
  });

  it("台帳に実測があれば、設定と実測の小さいほう（実測が小さい例）", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await saveModelTuning("ollama", "gemma4:12b", {
      measuredOutputTokens: 6500,
    });

    expect(resolveOutputTokensForPlanning("ollama", "gemma4:12b")).toBe(6500);
  });

  it("台帳に実測があれば、設定と実測の小さいほう（設定が小さい例）", async () => {
    installSettings({ maxOutputTokens: 2000 });
    await saveModelTuning("ollama", "gemma4:12b", {
      measuredOutputTokens: 6500,
    });

    expect(resolveOutputTokensForPlanning("ollama", "gemma4:12b")).toBe(2000);
  });

  /** 測定そのもの（`measureContext.ts`）はこの丸めを通さない。別テストで確認する */
  it("同じモデル名でもプロバイダが違えば台帳を混同しない", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await saveModelTuning("ollama", "gpt-oss-120b", {
      measuredOutputTokens: 6500,
    });

    // さくらの同名モデルは測っていないので、既定の見込みへ落ちる
    expect(resolveOutputTokensForPlanning("sakura", "gpt-oss-120b")).toBe(
      8192
    );
  });
});

/**
 * **実際に上限として送る値**（設計書6.77の第2段）。
 *
 * 見込み（上の `resolveOutputTokensForPlanning`）と分けてある。あちらの
 * 8,192の頭打ちは「場所をどれだけ空けるか」の話であって、「どこまで
 * 書いてよいか」ではない。**見込みをそのまま上限として送ると、測って
 * いないモデルでは上限が設定値の半分になり、長い応答が途中で切れる。**
 */
describe("resolveOutputTokensForSend", () => {
  afterEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  it("台帳に実測が無ければ、設定値をそのまま送る（8,192で頭を打たない）", async () => {
    installSettings({ maxOutputTokens: 16384 });

    expect(resolveOutputTokensForSend("ollama", "測っていないモデル")).toBe(
      16384
    );
  });

  it("台帳に実測があれば、そこまでを上限にする", async () => {
    // 実測は「そこまで書けた」ことの記録なので、上限にしてよい。
    // それ以上を許しても書けないことは測って分かっている
    installSettings({ maxOutputTokens: 16384 });
    await saveModelTuning("ollama", "gemma4:12b", {
      measuredOutputTokens: 6500,
    });

    expect(resolveOutputTokensForSend("ollama", "gemma4:12b")).toBe(6500);
  });

  it("設定のほうが小さければ、設定が勝つ", async () => {
    // 作者が設定で下げたのなら、実測より作者の指定を採る
    installSettings({ maxOutputTokens: 2000 });
    await saveModelTuning("ollama", "gemma4:12b", {
      measuredOutputTokens: 6500,
    });

    expect(resolveOutputTokensForSend("ollama", "gemma4:12b")).toBe(2000);
  });

  it("同じモデル名でもプロバイダが違えば台帳を混同しない", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await saveModelTuning("ollama", "gpt-oss-120b", {
      measuredOutputTokens: 6500,
    });

    expect(resolveOutputTokensForSend("sakura", "gpt-oss-120b")).toBe(16384);
  });
});

/**
 * **実測が、そのまま実送信の上限になることの危うさ**（0.33.0のレビュー）。
 *
 * 「書ける量」の測定（`features/measureContext.ts` の `measureOutputLimit`）は
 * **時間切れを「書けなかった」と数える**。遅いモデルでは、実際には書けるのに
 * 数百トークンで探索が終わり、その値が台帳へ入る。0.32.11からこの値が
 * 実送信のハード上限になったため、**測っただけで以後すべての応答が切られ、
 * 設定を上げても直らない**状態が作れてしまった。
 *
 * 二重に守る。
 *
 * 1. **床（1,024）を通す。** ほかの関数はすべて掛けているのに、送信の口だけ
 *    素通りだった。抽出のJSONが収まらない上限を送っても、そのチャンクは
 *    丸ごと捨てられるだけである
 * 2. **時間切れ混じりの測定は、上限として使わない。** 「待っても返らなかった」
 *    は「書けない」の証拠として弱い。**見込み（planning）や まとめ送信の
 *    絞り込みでは従来どおり使う**——あちらは場所の確保と量の見立てなので、
 *    安全側に小さく見るぶんには害が無い
 */
describe("実測を実送信の上限に使うときの守り", () => {
  afterEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  it("実測が小さすぎても、送る上限は1,024を下回らない", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await saveModelTuning("ollama", "遅いモデル", {
      measuredOutputTokens: 900,
    });

    expect(resolveOutputTokensForSend("ollama", "遅いモデル")).toBe(
      MINIMUM_OUTPUT_TOKENS
    );
  });

  it("時間切れ混じりの実測は、送る上限に使わない（設定値へ落とす）", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await saveModelTuning("ollama", "遅いモデル", {
      measuredOutputTokens: 2000,
      outputMeasureTimedOut: true,
    });

    expect(resolveOutputTokensForSend("ollama", "遅いモデル")).toBe(16384);
  });

  it("印の無い実測は、これまでどおり上限になる", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await saveModelTuning("ollama", "gemma4:12b", {
      measuredOutputTokens: 6500,
    });

    expect(resolveOutputTokensForSend("ollama", "gemma4:12b")).toBe(6500);
  });

  it("見込み（planning）は、時間切れ混じりの実測でも使う", async () => {
    // 見込みは「場所をどれだけ空けるか」なので、小さく見るぶんには安全
    installSettings({ maxOutputTokens: 16384 });
    await saveModelTuning("ollama", "遅いモデル", {
      measuredOutputTokens: 2000,
      outputMeasureTimedOut: true,
    });

    expect(resolveOutputTokensForPlanning("ollama", "遅いモデル")).toBe(2000);
  });

  it("まとめ送信の絞り込みも、時間切れ混じりの実測で絞る", async () => {
    installSettings({});
    await saveModelTuning("ollama", "遅いモデル", {
      measuredOutputTokens: 2000,
      outputMeasureTimedOut: true,
      measuredChars: 60000,
    });

    const settings = readChunkSettings(262144, undefined, {
      providerId: "ollama",
      model: "遅いモデル",
    });

    expect(settings.mergeCharsBeforeOutputCap).toBeDefined();
  });
});

/**
 * 上限の**出どころ**（0.33.0のレビュー）。
 *
 * 切り詰められたときの案内は、上限が設定値から来ているのか実測から
 * 来ているのかで直し方が違う。実測が効いているのに「設定を大きくして」と
 * 言うのは**嘘**である（大きくしても実測で頭打ちのままになる）。
 * **判定は1か所に持つ**——2か所で書くと、片方だけ直したときに食い違う。
 */
describe("上限の出どころ", () => {
  afterEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  it("実測が無ければ、出どころは設定", async () => {
    installSettings({ maxOutputTokens: 16384 });

    expect(resolveOutputLimitForSend("ollama", "測っていないモデル")).toEqual({
      tokens: 16384,
      source: "設定",
    });
  });

  it("実測で絞られていれば、出どころは実測", async () => {
    installSettings({ maxOutputTokens: 16384 });
    await saveModelTuning("ollama", "gemma4:12b", {
      measuredOutputTokens: 6500,
    });

    expect(resolveOutputLimitForSend("ollama", "gemma4:12b")).toEqual({
      tokens: 6500,
      source: "実測",
    });
  });

  it("設定のほうが小さければ、出どころは設定", async () => {
    installSettings({ maxOutputTokens: 2000 });
    await saveModelTuning("ollama", "gemma4:12b", {
      measuredOutputTokens: 6500,
    });

    expect(resolveOutputLimitForSend("ollama", "gemma4:12b")).toEqual({
      tokens: 2000,
      source: "設定",
    });
  });

  it("案内文は出どころで変わる", () => {
    expect(truncatedOutputAdvice({ tokens: 16384, source: "設定" })).toContain(
      "1回の応答の上限"
    );
    const measured = truncatedOutputAdvice({ tokens: 900, source: "実測" });
    expect(measured).toContain("AIチューニング");
    // **設定を上げろ、とは言わない。** 実測が上限なので直らない
    expect(measured).not.toContain("1回の応答の上限");
  });
});

/**
 * **測定そのもの（`measureOutputLimit`）はこの丸めを通さない**
 * （設計書6.65.16の2、注記）。あちらは「設定値まで実際に書けるか」を
 * 測るのが目的で、丸めると測る意味が無くなる。
 */
describe("measureContext.ts は resolveOutputTokensForPlanning を経由しない", () => {
  it("測定の呼び出しは resolveMaxOutputTokens を直接使う", () => {
    const file = path.join(
      __dirname,
      "..",
      "..",
      "src",
      "features",
      "measureContext.ts"
    );
    const code = fs.readFileSync(file, "utf8");
    expect(code).not.toContain("resolveOutputTokensForPlanning");
  });
});
