import { describe, expect, it } from "vitest";
import {
  bundledCharsPerTokenSamples,
  constantOf,
  decideNumCtx,
  measuredOf,
  outputReserveTokens,
  promptCharsOf,
} from "../../scripts/measureNumCtx.mjs";
import { contextSizeForPrompt } from "../../src/core/chunker";
import { MIN_CHARS_PER_TOKEN_SAMPLES } from "../../src/core/sizeBudget";
import { OUTPUT_RESERVE_TOKENS } from "../../src/ai/contextGuard";

/*
  測定台が送る `num_ctx` の決め方（`scripts/measure.mjs --runner ollama`）。

  2026-09-19 に4モデルを比べたとき、台が 32,768 を決め打ちしていたせいで
  **VRAM に収まるモデルほど遅い**という結果になった（qwen3:8b が
  全体7.56GBを使い、1.8GBが溢れていた）。ここで確かめるのは4つ。

    ① `--num-ctx` を打ったときは、その値に従う（作者が固定できる道）
    ② 打たなければ、**製品の関数**が出した値になる（式を写していない）
    ③ 送る量が分からなければ、黙って0にせず既定へ戻る
    ④ 製品の定数を源から読めている（写しを持たない）
*/

describe("--num-ctx を明示したとき", () => {
  it("--num-ctx を明示したら、その値をそのまま使う", () => {
    const decided = decideNumCtx({
      explicit: 8192,
      promptChars: 12_000,
      outputTokens: 8192,
      contextWindow: 131_072,
      contextSizeForPrompt,
      fallback: 32_768,
    });
    expect(decided.numCtx).toBe(8192);
    expect(decided.source).toContain("--num-ctx");
  });

  it("明示された値が大きくても、勝手に縮めない（VRAMの上限を探るための道）", () => {
    const decided = decideNumCtx({
      explicit: 131_072,
      promptChars: 1_000,
      outputTokens: 8192,
      contextWindow: 131_072,
      contextSizeForPrompt,
      fallback: 32_768,
    });
    expect(decided.numCtx).toBe(131_072);
  });
});

describe("明示が無いとき", () => {
  it("製品の contextSizeForPrompt が出した値と一致する", () => {
    const decided = decideNumCtx({
      explicit: null,
      promptChars: 12_000,
      outputTokens: 8192,
      contextWindow: 131_072,
      contextSizeForPrompt,
      fallback: 32_768,
    });
    expect(decided.numCtx).toBe(
      contextSizeForPrompt({
        promptChars: 12_000,
        outputTokens: 8192,
        contextWindow: 131_072,
      })
    );
    expect(decided.source).toContain("製品と同じ道");
  });

  it("3話・約3,700字の台なら、決め打ちの 32768 より小さくなる", () => {
    // 抽出（P-04a）の指示は約11,000字。本文1話ぶんを足しても、
    // 32,768 は5倍近く取りすぎだった——それがこの修正の発端である
    const decided = decideNumCtx({
      explicit: null,
      promptChars: 12_500,
      outputTokens: OUTPUT_RESERVE_TOKENS,
      contextWindow: 131_072,
      measured: measuredOf({ charsPerToken: 1.383 }, MIN_CHARS_PER_TOKEN_SAMPLES),
      contextSizeForPrompt,
      fallback: 32_768,
    });
    expect(decided.numCtx).toBeLessThan(32_768);
  });

  it("同梱の実測があると、当て推量より小さい num_ctx になる", () => {
    const common = {
      explicit: null,
      promptChars: 12_000,
      outputTokens: 8192,
      contextWindow: 131_072,
      contextSizeForPrompt,
      fallback: 32_768,
    };
    const guessed = decideNumCtx(common);
    const measured = decideNumCtx({
      ...common,
      measured: measuredOf(
        { charsPerToken: 1.383 },
        bundledCharsPerTokenSamples()
      ),
    });
    expect(measured.numCtx).toBeLessThan(guessed.numCtx);
  });

  it("モデルの上限が分からなければ、黙って0にせず既定へ戻る", () => {
    const decided = decideNumCtx({
      explicit: null,
      promptChars: 12_000,
      outputTokens: 8192,
      contextWindow: null,
      contextSizeForPrompt,
      fallback: 32_768,
    });
    expect(decided.numCtx).toBe(32_768);
    expect(decided.source).toContain("既定");
  });

  it("決めなかった理由を添えられる（2段めのプロンプトが見えない機能）", () => {
    const decided = decideNumCtx({
      explicit: null,
      promptChars: null,
      outputTokens: 8192,
      contextWindow: 131_072,
      fallbackReason: "2段めのプロンプトの長さが分からないので決めませんでした",
      contextSizeForPrompt,
      fallback: 32_768,
    });
    expect(decided.numCtx).toBe(32_768);
    expect(decided.source).toContain("2段め");
  });

  it("送るプロンプトの長さが分からなければ、既定へ戻る", () => {
    const decided = decideNumCtx({
      explicit: null,
      promptChars: null,
      outputTokens: 8192,
      contextWindow: 131_072,
      contextSizeForPrompt,
      fallback: 32_768,
    });
    expect(decided.numCtx).toBe(32_768);
  });
});

describe("同梱の実測の受け取り方", () => {
  it("件数を添える（添えないと製品は実測を信じない）", () => {
    const measured = measuredOf({ charsPerToken: 1.234 }, 5);
    expect(measured).toEqual({ charsPerToken: 1.234, charsPerTokenSamples: 5 });
  });

  it("同梱が無いモデルでは undefined を返す（当て推量のまま測る）", () => {
    expect(measuredOf(null, 5)).toBeUndefined();
    expect(measuredOf({}, 5)).toBeUndefined();
  });

  it("添える件数は、製品のしきい値を満たしている", () => {
    expect(bundledCharsPerTokenSamples()).toBeGreaterThanOrEqual(
      MIN_CHARS_PER_TOKEN_SAMPLES
    );
  });
});

describe("送るプロンプトの長さ", () => {
  it("チャンクのうち、いちばん長いもので測る", () => {
    const chars = promptCharsOf({
      systemPrompt: "あ".repeat(100),
      chunks: [{ userPrompt: "い".repeat(50) }, { userPrompt: "う".repeat(300) }],
    });
    expect(chars).toBe(400);
  });

  it("チャンクを返さない道具（作品ぜんたい）でも測れる", () => {
    const chars = promptCharsOf({
      systemPrompt: "あ".repeat(100),
      userPrompt: "い".repeat(20),
    });
    expect(chars).toBe(120);
  });

  it("何も返ってこなければ null（0字だったことにしない）", () => {
    expect(promptCharsOf({})).toBeNull();
    expect(promptCharsOf(null)).toBeNull();
  });
});

describe("製品の定数を源から読む", () => {
  it("OUTPUT_RESERVE_TOKENS は製品の値と一致する", () => {
    expect(outputReserveTokens()).toBe(OUTPUT_RESERVE_TOKENS);
  });

  it("桁区切り（1_000）の書き方でも読める", () => {
    expect(constantOf("const X = 16_384;", "X")).toBe(16_384);
  });

  it("源に見つからなければ止まる（既定値で代わりに動かない）", () => {
    expect(() => constantOf("何も書いていない", "X")).toThrowError(/X/);
  });
});
