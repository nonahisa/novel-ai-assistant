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
