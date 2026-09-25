import { describe, expect, test } from "vitest";
import {
  isBracketedNonAnswer,
  validateTypoIssues,
} from "../../../src/core/typoCheckValidation";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 誤字脱字の修正案が「（特に修正なし）」のような、括弧でくくった中身の無い
 * 言葉のとき（2026-09-26）。
 *
 * **再現**：中身の無い言葉の一覧（`placeholderText.ts`）は括弧を外してから
 * 一覧と突き合わせるが、「特に修正なし」は一覧に無いので通っていた。
 * 押すと本文の語が「（特に修正なし）」に置き換わる。
 *
 * **CLAUDE.md の失敗3（指示の言葉が答えとして返ってくる）の形**なので、
 * 言い方の一覧を足していくのではなく、「括弧でくくられ、中の言葉が本文の
 * その行に無い」という形で落とす。一方で、本文の括弧を直す正しい直し
 * （抜けた閉じ括弧を足す）は落とさない。
 */

function chunkOf(text: string): Chunk {
  return {
    filePath: "C:\\work\\001.txt",
    index: 0,
    text,
    startLine: 0,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "hash-1",
  };
}

function issueOf(original: string, target: string, suggestion: string) {
  return {
    issues: [
      {
        line: 1,
        original,
        target,
        suggestion,
        reason: "誤字",
        confidence: "medium",
      },
    ],
  };
}

describe("括弧でくくった中身の無い修正案は、指摘ごと落とす", () => {
  test.each([
    ["（特に修正なし）"],
    ["（修正不要）"],
    ["(なし)"],
    ["（誤字はありません）"],
    ["【問題なし】"],
  ])("%s", (suggestion) => {
    const text = "彼は静かに歩いて行った。";
    const result = validateTypoIssues(
      issueOf(text, "歩いて行った", suggestion),
      chunkOf(text),
      []
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("placeholder_suggestion");
  });

  test("括弧が無くても、「特に修正なし」の形は落とす（語の一覧は補助）", () => {
    const text = "彼は静かに歩いて行った。";
    const result = validateTypoIssues(
      issueOf(text, "歩いて行った", "特に修正なし"),
      chunkOf(text),
      []
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("placeholder_suggestion");
  });
});

describe("本文の括弧を直す正しい直しは落とさない", () => {
  test("抜けた閉じ括弧を足す（中の言葉は本文にある）", () => {
    const text = "彼は（笑いながら言った。";
    const result = validateTypoIssues(
      issueOf(text, "（笑いながら", "（笑いながら）"),
      chunkOf(text),
      []
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].suggestion).toBe("（笑いながら）");
  });

  test("括弧の中の誤字を直す（対象そのものが括弧を持つ）", () => {
    const text = "小声で（たぶんあ）とつぶやいた。";
    const result = validateTypoIssues(
      issueOf(text, "（たぶんあ）", "（たぶんな）"),
      chunkOf(text),
      []
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].suggestion).toBe("（たぶんな）");
  });

  test("抜けた開き括弧を足す（半角）", () => {
    const text = "その値は3.14)だった。";
    const result = validateTypoIssues(
      issueOf(text, "3.14)", "(3.14)"),
      chunkOf(text),
      []
    );

    expect(result.rejected).toEqual([]);
  });
});

describe("isBracketedNonAnswer", () => {
  test("本文のその行に中の言葉があれば、中身の無い言葉とは見ない", () => {
    // 作中の貼り紙の文言をそのまま括弧でくくる直し
    expect(
      isBracketedNonAnswer("貼り紙には特に修正なし）とあった。", "特に修正なし）", "（特に修正なし）")
    ).toBe(false);
  });

  test("括弧でくくっていない普通の直しは対象外", () => {
    expect(isBracketedNonAnswer("彼は歩いて行った。", "行った", "いった")).toBe(false);
  });

  test("中身の無い括弧（「（）」）も落とす", () => {
    expect(isBracketedNonAnswer("彼は歩いて行った。", "行った", "（）")).toBe(true);
  });
});
