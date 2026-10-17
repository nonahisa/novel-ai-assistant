import { describe, expect, test } from "vitest";
import {
  buildProofreadPrompt,
  PROOFREAD_REASONS,
  PROOFREAD_SCHEMA,
} from "../../../src/prompts/proofread";
import { validateProofreadIssues } from "../../../src/core/proofreadValidation";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 推敲のプロンプト（P-10）の形。
 *
 * 2026-10-01 に Sonnet が内部AIの代わりに答えた記録
 * （docs/measurements/2026-10-01-sonnet-as-internal-ai.md）で、次の3つが分かった。
 *
 * 1. プロンプトは形式名詞のひらき（「事」→「こと」）を勧めるのに、検算は
 *    `formal_noun` で落とす。**AIはプロンプトに従うほど落ちる**
 * 2. 出力例の JSON が JSON として読めない形（`""（何も入れない）` を文字列の中に置いていた）
 * 3. スキーマに reason・confidence の enum が無く、`line` が number
 */
const prompt = buildProofreadPrompt({
  chunkTextWithLineNumbers: "1: 彼は歩いた。",
  narrativeStyle: "",
  maxIssues: 3,
});

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

/** 【出力形式】の下の例を取り出す */
function exampleJson(): string {
  const head = prompt.indexOf("【出力形式】");
  const open = prompt.indexOf("{", head);
  return prompt.slice(open, prompt.lastIndexOf("}") + 1);
}

describe("形式名詞のひらき（作者の裁定、2026-09-26 午後）", () => {
  test("漢字ひらきの「提案してよい」に形式名詞を挙げない", () => {
    const allowed = between(prompt, "5. 漢字ひらき", "6. 語尾単調");
    expect(allowed).not.toContain("形式名詞");
    expect(allowed).not.toContain("〜する事");
  });

  test("「提案しないもの」に形式名詞のひらきを挙げる（揃えたいときは表記ゆれ）", () => {
    const forbidden = between(prompt, "【絶対に提案しないもの】", "【重要】");
    expect(forbidden).toContain("形式名詞");
    expect(forbidden).toContain("表記ゆれ");
  });
});

describe("出力例", () => {
  test("JSON として読める", () => {
    expect(() => JSON.parse(exampleJson())).not.toThrow();
  });

  test("例の値は、スキーマの選択肢の中にある（「high|medium|low」のような並べ書きをしない）", () => {
    const parsed = JSON.parse(exampleJson()) as {
      issues: Array<Record<string, unknown>>;
    };
    expect(parsed.issues.length).toBeGreaterThan(0);
    for (const issue of parsed.issues) {
      expect(PROOFREAD_REASONS as readonly unknown[]).toContain(issue.reason);
      expect(["high", "medium", "low"]).toContain(issue.confidence);
      expect(Number.isInteger(issue.line)).toBe(true);
      expect(typeof issue.suggestion).toBe("string");
    }
  });

  test("修正案を空にする例は、中身の無い \"\" で示す", () => {
    const parsed = JSON.parse(exampleJson()) as {
      issues: Array<{ suggestion: string }>;
    };
    expect(parsed.issues.some((issue) => issue.suggestion === "")).toBe(true);
  });

  /*
    指示の言葉は答えの中身として返ってくる（CLAUDE.md の失敗3）。
    例をそのまま書き写した答えが、別の本文で1件も通らないことを確かめる
  */
  test("例をそのまま写した答えは、検算を1件も通らない", () => {
    const chunk = {
      filePath: "C:/works/001.txt",
      index: 0,
      text: "朝、彼は駅へ向かった。\n空は晴れていた。",
      startLine: 0,
      chapterStart: 1,
      chapterEnd: 1,
      hash: "h",
      segments: [],
    } as unknown as Chunk;
    const echoed = JSON.parse(exampleJson()) as unknown;
    const { accepted } = validateProofreadIssues(echoed, chunk);
    expect(accepted).toEqual([]);
  });
});

/*
  冗長にも修正案を頼む（1.13、2026-10-16）。

  手元の測定（ハイエルフ全17話・gemma4:26b）で、通った冗長5件がすべて修正案 ""
  だった（検算は空にしていない。AI自身が空で返した）。漢字ひらきと同じ形で
  「片方を削った形を書く」と頼む。新しい指示の言葉が答えに写っても、本文を
  壊す修正案として通らないことも見る（CLAUDE.md の失敗3）。
*/
describe("冗長の修正案（1.13）", () => {
  const chunk = {
    filePath: "C:/works/007.txt",
    index: 0,
    text: "悶絶しながらしながら沼ワニに近づくと、槍は中ほどからぽっきり折れていた。",
    startLine: 0,
    chapterStart: 7,
    chapterEnd: 7,
    hash: "h",
    segments: [],
  } as unknown as Chunk;

  test("冗長は片方を削った形を書くよう頼んでいる", () => {
    // 1.14 で「必ず書く」へ強めた（proofreadRedundancyNoFix.test.ts）
    expect(prompt).toContain("冗長は、必ず修正案を書いてください。** 重なっている語の片方を削った形です");
  });

  test("片方を削った修正案は、そのまま適用できる形で通る", () => {
    const { accepted } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "悶絶しながらしながら沼ワニに近づくと",
            suggestion: "悶絶しながら沼ワニに近づくと",
            reason: "冗長",
            explanation: "「しながら」が二度繰り返されています",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].suggestion).toBe("悶絶しながら沼ワニに近づくと");
  });

  test("指示の言葉を修正案に写しても、本文を置き換える案としては通らない", () => {
    const { accepted } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "悶絶しながらしながら沼ワニに近づくと",
            suggestion: "重なっている語の片方を削った形",
            reason: "冗長",
            explanation: "「しながら」が二度繰り返されています",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    for (const issue of accepted) expect(issue.suggestion).toBe("");
  });

  test("削ったあとのつなぎに、ひらがなを足した形は通る（2026-10-16 の測り直し）", () => {
    const text = "いつもは門外で行われる確認が行われておらず、";
    const { accepted } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "いつもは門外で行われる確認が行われておらず",
            suggestion: "いつもは門外での確認が行われておらず",
            reason: "冗長",
            explanation: "「行われる」と「行われて」が重複しています",
            confidence: "high",
          },
        ],
      },
      { ...chunk, text } as Chunk
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].suggestion).toBe("いつもは門外での確認が行われておらず");
  });

  /*
    原文の末尾の記号を落とす修正案（2026-10-16 の測り直し、本体の裁定）。
    26b の冗長の修正案3件のうち2件が、原文の末尾の読点を落としていた。
    削った形なので上の関門は通り、［適用］で作者の読点が消える
  */
  function oneIssue(text: string, original: string, suggestion: string, reason = "冗長") {
    return validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original,
            suggestion,
            reason,
            explanation: "「しながら」が2回繰り返されています",
            confidence: "high",
          },
        ],
      },
      { ...chunk, text } as Chunk
    ).accepted;
  }

  test("原文の末尾の読点を落とした修正案は、指摘を残して修正案だけ外す", () => {
    const accepted = oneIssue(
      "悶絶しながらしながら沼ワニに近づくと、槍は折れていた。",
      "悶絶しながらしながら沼ワニに近づくと、",
      "悶絶しながら沼ワニに近づくと"
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].suggestion).toBe("");
    expect(accepted[0].suggestionCleared).toBe("drops_trailing_mark");
    expect(accepted[0].explanation).toContain("末尾の記号を落としていた");
  });

  test("読点だけを消す修正案も外れる", () => {
    const accepted = oneIssue(
      "加えて、害獣を駆除したことを示す討伐部位があれば、報酬が出る。",
      "加えて、害獣を駆除したことを示す討伐部位があれば、",
      "加えて、害獣を駆除したことを示す討伐部位があれば"
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].suggestion).toBe("");
    expect(accepted[0].suggestionCleared).toBe("drops_trailing_mark");
  });

  test("末尾の句点・閉じ括弧も同じ", () => {
    expect(
      oneIssue("「約10分ほど待った。」", "「約10分ほど待った。」", "「約10分待った。")[0]
        .suggestionCleared
    ).toBe("drops_trailing_mark");
    expect(
      oneIssue("約10分ほど待った。", "約10分ほど待った。", "約10分待った")[0].suggestionCleared
    ).toBe("drops_trailing_mark");
  });

  test("末尾の記号を残した修正案はそのまま通る（漢字ひらきも）", () => {
    expect(
      oneIssue(
        "悶絶しながらしながら沼ワニに近づくと、槍は折れていた。",
        "悶絶しながらしながら沼ワニに近づくと、",
        "悶絶しながら沼ワニに近づくと、"
      )[0].suggestion
    ).toBe("悶絶しながら沼ワニに近づくと、");
    const opened = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "是非この鯵を持って、",
            suggestion: "ぜひこの鯵を持って、",
            reason: "漢字ひらき",
            explanation: "「是非（ぜひ）」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      { ...chunk, text: "是非この鯵を持って、帰ってくれ。" } as Chunk
    ).accepted;
    expect(opened[0].suggestion).toBe("ぜひこの鯵を持って、");
  });

  test("削った形でない冗長の修正案は、指摘を残して修正案だけ外す（理由を添える）", () => {
    const { accepted } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "悶絶しながらしながら沼ワニに近づくと",
            suggestion: "苦しみつつ沼ワニに近づくと",
            reason: "冗長",
            explanation: "「しながら」が二度繰り返されています",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].suggestion).toBe("");
    expect(accepted[0].suggestionCleared).toBe("not_trimmed");
    expect(accepted[0].explanation).toContain("削った形ではなかった");
  });
});

describe("スキーマ", () => {
  const item = PROOFREAD_SCHEMA.properties.issues.items.properties;

  test("reason は7つの札のどれか", () => {
    expect(item.reason).toEqual({ type: "string", enum: [...PROOFREAD_REASONS] });
  });

  test("confidence は high・medium・low のどれか", () => {
    expect(item.confidence).toEqual({
      type: "string",
      enum: ["high", "medium", "low"],
    });
  });

  test("line は整数（誤字脱字と揃える）", () => {
    expect(item.line).toEqual({ type: "integer" });
  });
});
