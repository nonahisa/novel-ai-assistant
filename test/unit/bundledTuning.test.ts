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
  it("鍵は `providerId/model` の形（台帳と同じ）", () => {
    for (const key of bundledTuningKeys()) {
      expect(key).toMatch(/^[^/]+\/.+$/);
      expect(bundledTuningByKey(key)).toBeDefined();
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
    }
  });

  /**
   * **APIが教えてくれる値はAPIを優先する**（作者の守り5）。
   * 申告のコンテキスト長（`contextWindow`）を同梱表で上書きしない。
   */
  it("文脈の実効長（contextWindow）を、どの行にも載せていない", () => {
    for (const key of bundledTuningKeys()) {
      const seed = bundledTuningByKey(key) as Record<string, unknown>;
      expect(seed.contextWindow).toBeUndefined();
    }
  });

  /**
   * **出力速度と待ち時間は同梱しない**（作者の裁定）。
   * 回線・時間帯・向こうの混み具合で変わる。
   */
  it("速度・待ち時間を、どの行にも載せていない", () => {
    for (const key of bundledTuningKeys()) {
      const seed = bundledTuningByKey(key) as Record<string, unknown>;
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
      const seed = bundledTuningByKey(key) as Record<string, unknown>;
      expect(seed.contextLimitedByRate).toBeUndefined();
    }
  });

  it("実測どおりの値が入っている（2026-09-13）", () => {
    expect(bundledTuning("sakura", "preview/gemma-4-31B-it")).toEqual({
      charsPerToken: 1.383,
      measuredChars: 339_804,
      contextHitCeiling: false,
      measuredAt: "2026-09-13",
    });
    expect(bundledTuning("sakura", "gpt-oss-120b")?.charsPerToken).toBe(1.065);
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
