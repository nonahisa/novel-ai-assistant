import { describe, expect, test } from "vitest";
import {
  buildFindingAdvicePrompt,
  FINDING_ADVICE_HINTS,
  FINDING_ADVICE_MATERIAL_MAX_CHARS,
  FINDING_ADVICE_SCHEMA,
  FINDING_ADVICE_SYSTEM_PROMPT,
} from "../../../src/prompts/findingAdvice";
import { parseFindingAdvice } from "../../../src/core/findingAdviceValidation";

/**
 * P-47 推敲の指摘への短い助言の組み立て。
 *
 * 相談パネル（P-21）を通さないので、相談のシステム指示・材料・機能の一覧は
 * 入らない（作者の報告 2026-10-05「くどすぎます」）。
 */

const input = {
  quote: "　彼女は外を見ている彼女を見ていた。",
  finding: "視点：ここだけ語り手が外から見ています",
  before: "　窓の外は雪だった。",
  after: "　鐘が鳴った。",
};

describe("依頼文", () => {
  const prompt = buildFindingAdvicePrompt(input);

  test("一文・指摘・前後の段落が入り、前後は「答えに引用しない」と断る", () => {
    expect(prompt).toContain(input.quote.trim());
    expect(prompt).toContain(input.finding);
    expect(prompt).toContain("【前の段落（読むためだけ。答えに引用しない）】");
    expect(prompt).toContain("【後ろの段落（読むためだけ。答えに引用しない）】");
    expect(prompt).toContain("窓の外は雪だった。");
  });

  test("前後が無ければ見出しごと省く", () => {
    const bare = buildFindingAdvicePrompt({ quote: input.quote, finding: input.finding });
    expect(bare).not.toContain("前の段落");
    expect(bare).not.toContain("後ろの段落");
  });

  test("字数・数の上限と、案の名前だけの選択肢を禁じる指示がある", () => {
    expect(prompt).toContain("60字以内の1文");
    expect(prompt).toContain("0〜2個");
    expect(prompt).toContain("40字以内");
    expect(prompt).toContain("「Aの方向」「案1」のような、案の名前だけの選択肢を書かないこと");
    expect(prompt).toContain("一文の全体を書き直さないこと");
  });

  test("長い材料は頭から切る", () => {
    const long = buildFindingAdvicePrompt({ quote: "あ".repeat(500), finding: "f" });
    expect(long).toContain(`${"あ".repeat(FINDING_ADVICE_MATERIAL_MAX_CHARS)}…`);
    expect(long).not.toContain("あ".repeat(FINDING_ADVICE_MATERIAL_MAX_CHARS + 1));
  });

  test("相談パネルの材料（機能の一覧・創作観）は入らない", () => {
    const all = FINDING_ADVICE_SYSTEM_PROMPT + prompt;
    expect(all).not.toContain("起動できる機能");
    expect(all).not.toContain("創作観");
    expect(all).toContain("機能の案内・挨拶・前置き・まとめを書かないこと");
  });
});

describe("スキーマ", () => {
  test("point と examples（from・to の組、2つまで）だけ", () => {
    expect(Object.keys(FINDING_ADVICE_SCHEMA.properties)).toEqual(["point", "examples"]);
    expect(FINDING_ADVICE_SCHEMA.properties.examples.maxItems).toBe(2);
    expect(Object.keys(FINDING_ADVICE_SCHEMA.properties.examples.items.properties)).toEqual([
      "from",
      "to",
    ]);
  });
});

/**
 * **指示の言葉は、そのまま答えとして返ってくる**（CLAUDE.md「繰り返し起きた
 * 失敗3」）。依頼文に書いた項目名は、どれも検証で弾かれること
 */
describe("指示の言葉の返り", () => {
  test.each(FINDING_ADVICE_HINTS.filter((hint) => hint.length >= 3))(
    "「%s」がそのまま返ったら、引っかかりとして出さない",
    (hint) => {
      const advice = parseFindingAdvice(
        JSON.stringify({ point: hint, examples: [] }),
        { quote: input.quote }
      );
      expect(advice).toBeUndefined();
    }
  );
});
