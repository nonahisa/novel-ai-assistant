import { describe, expect, it } from "vitest";
import {
  bundledTuning,
  bundledTuningByKey,
  bundledTuningKeys,
} from "../../../src/core/bundledTuning";
import { parseDeclaredContextLimit } from "../../../src/core/tuningStages";
import {
  TUNING_WORK_PLANTED_TYPOS,
  TUNING_WORK_SAMPLE_VERSION,
  TUNING_WORK_TRAPS,
} from "../../../src/core/tuningWorkSample";
import { typoPromptVersion } from "../../../src/prompts/typoCheck";

/**
 * 測った値の初期値の同梱（作者の裁定、2026-09-13）。
 *
 * **作者が決めた5つの守りを、ここで固定する。** どれも「うっかり足した
 * 1行」で破れるもので、破れても動きはするので、テストが無いと気づけない。
 *
 * 台帳との混ぜ方（欄ごと・作者の実測が勝つ・保存へ漏らさない）は
 * `modelTuningBundled.test.ts` が見る。
 */

describe("同梱する実測の一覧", () => {
  it("鍵は `providerId/model` の形（台帳と同じ）で、引いたものは台帳の実物である", () => {
    for (const key of bundledTuningKeys()) {
      expect(key).toMatch(/^[^/]+\/.+$/);

      // `expect(bundledTuningByKey(key)).toBeDefined()` だけでは、
      // 中身が正しいかに関係なく（極端には空のオブジェクトを返しても）
      // 常に真になる。**鍵から引く関数（`bundledTuningByKey`）と
      // providerId/model から引く関数（`bundledTuning`）が、同じ要素を
      // 指していること**を見て、中身の取り違えを検査する。
      const slash = key.indexOf("/");
      const providerId = key.slice(0, slash);
      const model = key.slice(slash + 1);
      expect(bundledTuningByKey(key)).toBe(bundledTuning(providerId, model));
    }
  });

  it("どの行にも、測った日が入っている（作者の守り4）", () => {
    for (const key of bundledTuningKeys()) {
      const seed = bundledTuningByKey(key);
      // **古くなったら黙って使わない**ための手がかり。日付が無いと、
      // いつの値なのか誰にも分からないまま使われ続ける
      expect(seed?.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  /**
   * **読める長さはクラウドだけ**（作者の裁定）。
   * ローカルは VRAM 次第で、同じモデルでも機械が変われば別の値になる。
   */
  it("ローカル（ollama / lmstudio）に、読める長さを載せていない", () => {
    for (const key of bundledTuningKeys()) {
      if (!/^(ollama|lmstudio)\//.test(key)) continue;
      expect(bundledTuningByKey(key)?.measuredChars).toBeUndefined();
      // トークン数で言い直しただけの同じ値なので、こちらも同じ理由で載せない
      expect(bundledTuningByKey(key)?.contextWindow).toBeUndefined();
    }
  });

  /**
   * **APIが教えてくれる値はAPIを優先する**（作者の守り5）。
   *
   * 2026-09-19 に例外が1つ開いた——**さくらのAIはモデル一覧APIが
   * コンテキスト長を返さない**ので、上書きされる申告がそもそも無い。
   * 既定の 32,000 は申告ではなく製品の当て推量で、31Bの実測は
   * 273,001トークンだった。載せてよいのは**申告しないプロバイダの行だけ**で、
   * その線引きは `contextWindowResolve.test.ts` がソースを読んで見張る
   * （共通の読み順 `resolveContextWindow` を通るか、で判る）。
   *
   * ここで固定するのは、**載せてよい測定の強さ**である。
   */
  it("文脈の実効長を載せた行は、天井で止まっていない測定である", () => {
    for (const key of bundledTuningKeys()) {
      const seed = bundledTuningByKey(key);
      if (seed?.contextWindow === undefined) continue;
      // 天井に当たった測定の値は「そこまでは確かめた」下限でしかない。
      // それを上限として配ると、**実際より大きい値**になりうる
      expect(seed.contextHitCeiling, key).toBe(false);
      // どこから来た数字かを辿れるように、測った字数か、サーバー自身が
      // 述べた文のどちらかを添える
      if (seed.contextDeclared !== undefined) {
        // **数字が文の中に実在すること。** 写し間違いを通さない
        expect(seed.contextDeclared, key).toContain(String(seed.contextWindow));
      } else {
        expect(seed.measuredChars, key).toBeGreaterThan(0);
      }
    }
  });

  /**
   * **サーバー自身が述べた長さ**（比べ 2026-09-25〜26）。
   *
   * llm-jp と Phi は、出力の上限を大きく送ったときの400の本文に、自分の
   * 読める長さを書いてきた。字を詰めて測る測定より確かな値である
   * （向こうの設定そのもの）。**文をそのまま持つ**——どこから来た数字かを
   * 後から辿れるように。
   */
  it("サーバーが述べた長さは、その文と一緒に載せる（2026-09-26）", () => {
    for (const model of [
      "llm-jp-3.1-8x13b-instruct4",
      "preview/Phi-4-mini-instruct-cpu",
    ]) {
      const seed = bundledTuning("sakura", model);
      expect(seed?.contextWindow, model).toBe(4096);
      expect(seed?.contextDeclared, model).toContain("4096");
      expect(seed?.measuredAt, model).toBe("2026-09-26");
    }
    // 字/トークンは実際に5回送って測った最小値（製品と同じ切り捨て）
    expect(bundledTuning("sakura", "llm-jp-3.1-8x13b-instruct4")?.charsPerToken).toBe(1.712);
    expect(bundledTuning("sakura", "preview/Phi-4-mini-instruct-cpu")?.charsPerToken).toBe(1.235);
  });

  /**
   * **出力速度と待ち時間は同梱しない**（作者の裁定）。
   * 回線・時間帯・向こうの混み具合で変わる。
   */
  it("速度・待ち時間を、どの行にも載せていない", () => {
    for (const key of bundledTuningKeys()) {
      // 「載せていない項目」を見たいので、**型に無い名前も引ける形**で受ける。
      // 写しを作れば、型を偽らずに（`as` を使わずに）名前で引ける
      const seed: Record<string, unknown> = { ...bundledTuningByKey(key) };
      expect(seed.outputTokensPerSecond).toBeUndefined();
      expect(seed.timeoutSeconds).toBeUndefined();
      expect(seed.speedSource).toBeUndefined();
    }
  });

  /**
   * **分あたりの上限で頭打ちになった測定は載せない**（作者の守り3）。
   * 上限はプランで変わるので、他人の環境では別の値になる。
   * 2026-09-13 時点では Gemini がこれに当たり、載せていない。
   */
  it("分あたりの上限で降りた測定（gemini）を載せていない", () => {
    for (const key of bundledTuningKeys()) {
      expect(key.startsWith("gemini/")).toBe(false);
    }
    for (const key of bundledTuningKeys()) {
      const seed: Record<string, unknown> = { ...bundledTuningByKey(key) };
      expect(seed.contextLimitedByRate).toBeUndefined();
    }
  });

  it("実測どおりの値が入っている（2026-09-13）", () => {
    expect(bundledTuning("sakura", "preview/gemma-4-31B-it")).toEqual({
      charsPerToken: 1.383,
      measuredChars: 339_804,
      // 測った字数を、台帳へ書くときと同じ換算でトークンへ直した値
      // （339,804 ÷ (1.383 × 0.9)）。作者の台帳の値と一致する
      contextWindow: 273_001,
      contextHitCeiling: false,
      // 考えないモデル（2026-09-26 の見分けの段）
      thinkingSeen: false,
      thinkingMeasuredAt: "2026-09-26",
      measuredAt: "2026-09-13",
    });
    expect(bundledTuning("sakura", "gpt-oss-120b")?.charsPerToken).toBe(1.065);
    expect(bundledTuning("sakura", "gpt-oss-120b")?.contextWindow).toBe(138_597);
    expect(bundledTuning("ollama", "qwen3:8b")?.charsPerToken).toBe(1.234);
    // gemma-4 系は 12B でも 31B でも、手元でもさくらでも同じ値
    expect(bundledTuning("ollama", "gemma4:12b")?.charsPerToken).toBe(1.383);
  });

  it("知らないモデルには何も返さない", () => {
    expect(bundledTuning("ollama", "まだ測っていないモデル")).toBeUndefined();
    expect(bundledTuning("claude", "claude-opus-5")).toBeUndefined();
  });

  /**
   * **推測を載せない。** 「gemma-4 系だから同じはず」という当てはめは
   * 実測ではないので、規則6の例外（測らないと分からない値の初期値）の
   * 範囲を出る。載っているのは実際に測った10件だけである。
   */
  it("載せているのは、実際に測った10件だけ", () => {
    expect(bundledTuningKeys().sort()).toEqual([
      "ollama/gemma4:12b",
      "ollama/gemma4:26b",
      "ollama/gemma4:e4b",
      "ollama/qwen3:8b",
      "sakura/gpt-oss-120b",
      "sakura/llm-jp-3.1-8x13b-instruct4",
      "sakura/preview/Kimi-K2.6",
      "sakura/preview/Phi-4-mini-instruct-cpu",
      "sakura/preview/Qwen3.6-35B-A3B",
      "sakura/preview/gemma-4-31B-it",
    ]);
  });
});

/**
 * **AIチューニングの「仕事に近い形で測る」から足した値**（2026-09-26）。
 */
describe("考えるモデルの性質・精度の目安・サーバーが述べた長さ", () => {
  /**
   * 申告の文は、製品が断られた文から長さを読むのと**同じ読み方**で読めること。
   * 写し間違えた数字や、別のモデルの文を載せていないかを見る。
   */
  it("サーバーが述べた文から、製品と同じ読み方で同じ長さが読める", () => {
    for (const key of bundledTuningKeys()) {
      const seed = bundledTuningByKey(key);
      if (seed?.contextDeclared === undefined) continue;
      expect(parseDeclaredContextLimit(seed.contextDeclared), key).toBe(seed.contextWindow);
    }
    expect(bundledTuning("sakura", "preview/Qwen3.6-35B-A3B")?.contextWindow).toBe(262_144);
    expect(bundledTuning("sakura", "preview/Kimi-K2.6")?.contextWindow).toBe(262_144);
  });

  /**
   * **字/トークンは、5回以上の測定が無いモデルに載せない。** Qwen3.6・Kimi・
   * 26b は誤字脱字の頼み方で1〜2回測れただけで、指示の字が多い形では
   * 字/トークンが高めに出る（本文のトークンを少なく数える側＝危ない側）。
   */
  it("今回足した行には、字/トークンを載せていない", () => {
    for (const key of [
      "sakura/preview/Qwen3.6-35B-A3B",
      "sakura/preview/Kimi-K2.6",
      "ollama/gemma4:e4b",
      "ollama/gemma4:26b",
    ]) {
      expect(bundledTuningByKey(key)?.charsPerToken, key).toBeUndefined();
    }
  });

  it("思考の欄は、見分けの段が書くのと同じ組み合わせだけ", () => {
    for (const key of bundledTuningKeys()) {
      const seed = bundledTuningByKey(key);
      if (seed === undefined) continue;
      if (seed.thinkingSeen === undefined) {
        expect(seed.thinkingOffWorks, key).toBeUndefined();
        expect(seed.thinkingOverheadTokens, key).toBeUndefined();
        continue;
      }
      // どの行にも、いつ見分けたかを添える
      expect(seed.thinkingMeasuredAt, key).toMatch(/^\d{4}-\d{2}-\d{2}/);
      if (seed.thinkingSeen === false) {
        // 考えないモデルに「止める指定の効き目」は無い
        expect(seed.thinkingOffWorks, key).toBeUndefined();
      }
      // 思考のぶんは「止められない」ときだけ持つ（`unsuppressedThinkingTokens`）
      if (seed.thinkingOverheadTokens !== undefined) {
        expect(seed.thinkingOffWorks, key).toBe(false);
        expect(seed.thinkingOverheadTokens, key).toBeGreaterThan(0);
      }
    }
    expect(bundledTuning("sakura", "gpt-oss-120b")?.thinkingOverheadTokens).toBe(2560);
  });

  /**
   * 精度の目安は**いまの頼み方と文の版**で測ったものだけを載せる。版1（罠なし）
   * の結果を載せると、同梱した瞬間から「古い結果」になる。
   */
  it("精度の目安は、いまの版の文（罠5つ）で測ったものだけ", () => {
    for (const key of bundledTuningKeys()) {
      const accuracy = bundledTuningByKey(key)?.typoAccuracy;
      if (accuracy === undefined) continue;
      expect(accuracy.sampleVersion, key).toBe(TUNING_WORK_SAMPLE_VERSION);
      expect(accuracy.total, key).toBe(TUNING_WORK_PLANTED_TYPOS.length);
      expect(accuracy.trapTotal, key).toBe(TUNING_WORK_TRAPS.length);
      expect(accuracy.promptVersion, key).toBe(typoPromptVersion(accuracy.smallPrompt));
      expect(accuracy.hits, key).toBeLessThanOrEqual(accuracy.total);
      // 罠に掛かった数は、誤検出の内訳である
      expect(accuracy.trapHits, key).toBeLessThanOrEqual(accuracy.falsePositives);
      expect(accuracy.measuredAt, key).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  /**
   * **時間は同梱しない。** 同じ測定で1000字あたりの秒数も取れていたが、
   * GPU に入りきるかで何倍も変わる（26b は作者の機械で CPU と分けて載った）。
   */
  it("仕事に近い形の時間を、どの行にも載せていない", () => {
    for (const key of bundledTuningKeys()) {
      const seed: Record<string, unknown> = { ...bundledTuningByKey(key) };
      expect(seed.workSecondsPer1000Chars, key).toBeUndefined();
      expect(seed.workFixedSeconds, key).toBeUndefined();
    }
  });
});
