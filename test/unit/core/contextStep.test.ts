import { describe, expect, test } from "vitest";
import { contextSizeForPrompt } from "../../src/core/chunker";

/**
 * `num_ctx` を段に丸める（設計書6.52）。
 *
 * Ollama は `num_ctx` が変わるとモデルを読み込み直す。チャンクの長さは
 * 1つずつ違うので、丸めないと**毎回読み込み直しになる**——作者の報告
 * 「設定資料抽出中、一瞬CLの画面が複数回立ち上がる。チャンクの度に」
 * （2026-08-30）はこれだった。
 */
describe("num_ctx は段に丸める", () => {
  const base = { outputTokens: 4096, contextWindow: 131072 };

  test("長さの違うチャンクが、同じ num_ctx になる", () => {
    // 20,000字と18,000字（約28,600と約25,700トークン）
    const big = contextSizeForPrompt({ ...base, promptChars: 20000 });
    const small = contextSizeForPrompt({ ...base, promptChars: 18000 });
    expect(big).toBe(small);
  });

  test("4096の倍数になる", () => {
    for (const chars of [1000, 5000, 12345, 20000]) {
      const value = contextSizeForPrompt({ ...base, promptChars: chars });
      expect(value % 4096).toBe(0);
    }
  });

  test("必要な量を下回らない（切り捨てない）", () => {
    // 丸めは必ず切り上げ。足りない値にしてはいけない
    const chars = 10000;
    const value = contextSizeForPrompt({ ...base, promptChars: chars });
    const needed = Math.ceil((Math.ceil(chars / 0.7) + 4096) * 1.1);
    expect(value).toBeGreaterThanOrEqual(needed);
  });

  test("モデルの上限は超えない", () => {
    const value = contextSizeForPrompt({
      outputTokens: 4096,
      contextWindow: 8192,
      promptChars: 100000,
    });
    expect(value).toBe(8192);
  });

  test("下限4096は保つ", () => {
    expect(
      contextSizeForPrompt({ ...base, promptChars: 10, outputTokens: 10 })
    ).toBe(4096);
  });
});
