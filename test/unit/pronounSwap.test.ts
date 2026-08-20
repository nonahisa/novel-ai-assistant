import { describe, expect, test } from "vitest";
import {
  isPronounSwap,
  validateTypoIssues,
} from "../../src/core/typoCheckValidation";
import type { Chunk } from "../../src/core/chunker";

/**
 * 一人称の入れ替えを止める。
 *
 * **一人称は作品の根幹である。**「僕」で書かれた小説を「私」に直されたら、
 * 語り手が別人になる。誤字ではない。
 *
 * 実データで返ってきた（`gemma4:e4b`、2026-08-18）：
 *
 *     「僕が所属する」→「私が所属する」（誤変換）
 *     「僕ら」→「私たち」（誤変換）
 *
 * 方言（`keep_words.json`）と違い、**どの小説にも必ず一人称がある**ので、
 * 作者が登録するのを待たず最初から守る。
 */
function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/x/episode_0001.txt",
    text,
    startLine: 0,
    hash: "h",
  } as Chunk;
}

describe("人称の入れ替えを見分ける", () => {
  test.each([
    ["僕が所属する", "私が所属する"],
    ["僕ら", "私たち"],
    ["俺は行く", "私は行く"],
    ["わたしの家", "あたしの家"],
    ["お前が来い", "君が来い"],
    // 複数形どうし
    ["俺たち", "僕ら"],
    ["我々の意見", "私たちの意見"],
  ])("入れ替えと見なす: 「%s」→「%s」", (target, suggestion) => {
    expect(isPronounSwap(target, suggestion)).toBe(true);
  });

  test.each([
    // **本物の誤字を巻き込まない**
    ["ｈっきりと", "はっきりと"],
    ["ことはことは", "ことは"],
    ["溢れ出だした", "溢れ出した"],
    // 人称は含むが、直しているのは別のところ
    ["私わ行く", "私は行く"],
    ["僕の家えいく", "僕の家へいく"],
    // 人称が絡むが、脱字を補っている
    ["わたし", "わたしは"],
  ])("入れ替えではない: 「%s」→「%s」", (target, suggestion) => {
    expect(isPronounSwap(target, suggestion)).toBe(false);
  });

  test("同じものは対象外（no_change が先に見る）", () => {
    expect(isPronounSwap("僕", "僕")).toBe(false);
  });

  test("人称を含まないものは対象外", () => {
    // 潰しても何も変わらない文どうしを、同じだと見なさない
    expect(isPronounSwap("犬が走る", "猫が走る")).toBe(false);
  });
});

describe("検証の流れの中でも弾かれる", () => {
  test("「僕が所属する」→「私が所属する」を弾く", () => {
    const text = "僕が所属する部署は生活保護課だ。";
    const result = validateTypoIssues(
      {
        issues: [
          {
            line: 1,
            original: text,
            target: "僕が所属する",
            suggestion: "私が所属する",
            reason: "誤変換",
            confidence: "medium",
          },
        ],
      },
      chunkOf(text),
      []
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("pronoun_change");
  });

  test("一人称を含む行の、本物の誤字は通す", () => {
    const text = "僕の手足の冷たさがｈっきりとわかる。";
    const result = validateTypoIssues(
      {
        issues: [
          {
            line: 1,
            original: text,
            target: "ｈっきりと",
            suggestion: "はっきりと",
            reason: "誤変換",
            confidence: "high",
          },
        ],
      },
      chunkOf(text),
      []
    );

    expect(result.accepted).toHaveLength(1);
  });
});
