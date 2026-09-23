import { describe, expect, it } from "vitest";
import {
  bundledTuning,
  bundledTuningByKey,
  bundledTuningKeys,
} from "../../src/core/bundledTuning";

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
      // どこから来た数字かを辿れるように、測った字数も添える
      expect(seed.measuredChars, key).toBeGreaterThan(0);
    }
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
   * 範囲を出る。載っているのは実際に測った4件だけである。
   */
  it("載せているのは、実際に測った4件だけ", () => {
    expect(bundledTuningKeys().sort()).toEqual([
      "ollama/gemma4:12b",
      "ollama/qwen3:8b",
      "sakura/gpt-oss-120b",
      "sakura/preview/gemma-4-31B-it",
    ]);
  });
});
