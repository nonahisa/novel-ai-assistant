import { describe, expect, test } from "vitest";
import { validateProofreadIssues } from "../../../src/core/proofreadValidation";
import type { Chunk } from "../../../src/core/chunker";
import {
  PROOFREAD_VERSION,
  buildProofreadPrompt,
} from "../../../src/prompts/proofread";

/**
 * 推敲の「冗長」の直しの案が空（作者の裁定 2026-10-17「直しの案を出させる」。A23）。
 *
 * 1.13 で冗長にも修正案を頼んだが、ハイエルフ全17話・26b で冗長10件のうち6件が
 * まだ修正案 "" で通った。頼み方をもう一段はっきりさせ（1.14）、それでも空なら
 * **検算の結果に「案なし」の印を付ける**（AIが書かなかったのか、検算が外したのか、
 * 初めから案の要らない札なのかを、結果から見分けられるようにする）。
 */

function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/012.txt",
    index: 0,
    text,
    startLine: 0,
    chapterStart: 12,
    chapterEnd: 12,
    hash: "h",
    segments: [],
  } as unknown as Chunk;
}

const prompt = buildProofreadPrompt({
  chunkTextWithLineNumbers: "1: 本文",
  narrativeStyle: "一人称",
  maxIssues: 5,
} as Parameters<typeof buildProofreadPrompt>[0]);

describe("頼み方（1.14）", () => {
  test("版を上げた", () => {
    expect(PROOFREAD_VERSION).toBe("1.14");
  });

  test("冗長は修正案を必ず書き、削った形が書けないなら冗長として挙げないよう頼む", () => {
    expect(prompt).toContain("冗長は、必ず修正案を書いてください");
    expect(prompt).toContain("削った形が書けないものは、冗長として挙げないでください");
  });

  test("修正案を空にする札を名指しする（冗長は入れない）", () => {
    const rule = prompt.slice(prompt.indexOf("suggestion を \"\" にするのは"));
    const line = rule.slice(0, rule.indexOf("\n"));
    expect(line).toContain("長文");
    expect(line).not.toContain("冗長");
  });
});

describe("冗長なのに修正案が空のとき", () => {
  const text = "　ダラダラと汗まみれになりながら、坂を上った。";

  test("指摘は残し、「案なし」の印を付ける", () => {
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "ダラダラと汗まみれになりながら、",
            suggestion: "",
            reason: "冗長",
            explanation: "『ダラダラと』と『汗まみれ』が重なっています",
            confidence: "medium",
          },
        ],
      },
      chunkOf(text)
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("");
    expect(result.accepted[0].suggestionMissing).toBe(true);
  });

  test("初めから案の要らない札（長文）には印を付けない", () => {
    const long =
      "　門番は帳面を閉じ、眼鏡を外し、窓の外を眺め、溜め息をつき、椅子から立ち上がり、" +
      "扉の前までゆっくりと歩いて行き、錆びた真鍮の取っ手に手を掛けたところで、" +
      "ようやく振り返って、待たされ続けた旅人たちに向かって口を開いた。";
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "門番は帳面を閉じ、",
            suggestion: "",
            reason: "長文",
            explanation: "『門番は』で始まる一文が80字・読点7個で、切れ目が分かりません",
            confidence: "medium",
          },
        ],
      },
      chunkOf(long)
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestionMissing).toBeUndefined();
  });

  test("修正案があれば印を付けない", () => {
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "悶絶しながらしながら沼ワニに近づくと、",
            suggestion: "悶絶しながら沼ワニに近づくと、",
            reason: "冗長",
            explanation: "『しながら』が2回重なっています",
            confidence: "high",
          },
        ],
      },
      chunkOf("悶絶しながらしながら沼ワニに近づくと、槍は折れていた。")
    );
    expect(result.accepted[0].suggestion).toBe("悶絶しながら沼ワニに近づくと、");
    expect(result.accepted[0].suggestionMissing).toBeUndefined();
  });
});
