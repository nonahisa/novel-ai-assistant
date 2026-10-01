import { describe, expect, test } from "vitest";
import { validateProofreadIssues } from "../../../src/core/proofreadValidation";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 推敲の修正案が**黙って空になる**道を塞ぐ（2026-10-01 の記録の不具合4）。
 *
 * 記録（docs/measurements/2026-10-01-sonnet-as-internal-ai.md）では、第2話123行の
 * 台詞「痛いところはない？」に「漢字ひらき」の札で「痛いとこはない？」という
 * 修正案を返したところ、**修正案だけが消えて指摘は通った**。ひらいた漢字が1つも
 * 無いので、これはひらきではない。作者には「ひらがなにできます」とだけ出て、
 * どこの何をひらくのか分からない。
 *
 * 修正案を空にして指摘を残す扱い（作者の裁定、2026-09-17）そのものは変えない。
 * ただし、**なぜ空にしたのか**を結果に残す（`suggestionCleared` と説明の注記）。
 */
function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/002.txt",
    index: 0,
    text,
    startLine: 0,
    chapterStart: 2,
    chapterEnd: 2,
    hash: "h",
    segments: [],
  } as unknown as Chunk;
}

describe("漢字ひらきで、修正案が漢字を1つもひらいていない", () => {
  test("記録の形：台詞の「痛いところ」→「痛いとこ」は落とす", () => {
    const chunk = chunkOf("　僕は駆け寄った。\n「リナ、痛いところはない？」");
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 2,
            original: "痛いところはない？",
            suggestion: "痛いとこはない？",
            reason: "漢字ひらき",
            explanation: "ひらがなにできます",
            confidence: "low",
          },
        ],
      },
      chunk
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual(["opens_no_kanji"]);
  });

  test("ひらいた漢字があれば落とさない（然し→しかし）", () => {
    const chunk = chunkOf("然し、彼は来なかった。");
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "然し、彼は",
            suggestion: "しかし、彼は",
            reason: "漢字ひらき",
            explanation: "「然し（しかし）」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("しかし、彼は");
    expect(result.accepted[0].suggestionCleared).toBeUndefined();
  });
});

describe("修正案を空にしたら、理由を残す", () => {
  test("言い換え（然し→でも）：指摘は残し、理由と注記を付ける", () => {
    const chunk = chunkOf("然し、彼は来なかった。");
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "然し",
            suggestion: "でも",
            reason: "漢字ひらき",
            explanation: "「然し（しかし）」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(result.accepted).toHaveLength(1);
    const [issue] = result.accepted;
    expect(issue.suggestion).toBe("");
    expect(issue.suggestionCleared).toBe("paraphrase");
    expect(issue.explanation).toContain("「然し（しかし）」で読みが詰まります");
    expect(issue.explanation).toContain("修正案");
  });

  test("原文の後ろを落とした修正案：理由と注記を付ける", () => {
    const original = "まず最初に彼は扉の前に立って静かに深く息を吸い込んだのだった";
    const chunk = chunkOf(`${original}。`);
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original,
            suggestion: "まず彼は",
            reason: "冗長",
            explanation: "『まず』と『最初に』が同じ意味です",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("");
    expect(result.accepted[0].suggestionCleared).toBe("drops_tail");
    expect(result.accepted[0].explanation).toContain("修正案");
  });

  test("行に2か所ある原文：理由と注記を付ける", () => {
    const chunk = chunkOf("丁度いい、丁度いいと彼は言った。まず最初に。");
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "丁度いい",
            suggestion: "ちょうどいい",
            reason: "漢字ひらき",
            explanation: "「丁度（ちょうど）」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("");
    expect(result.accepted[0].suggestionCleared).toBe("ambiguous_in_line");
    expect(result.accepted[0].explanation).toContain("修正案");
  });

  test("「空文字」の書き写しは、AIが空にしたつもりなので注記は付けない", () => {
    const original = "まず最初に、彼は立ち上がった";
    const chunk = chunkOf(`${original}。`);
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original,
            suggestion: "空文字",
            reason: "冗長",
            explanation: "『まず』と『最初に』が同じ意味です",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("");
    expect(result.accepted[0].suggestionCleared).toBe("placeholder");
    expect(result.accepted[0].explanation).toBe("『まず』と『最初に』が同じ意味です");
  });

  test("初めから空の修正案は、空にしたのではないので理由を付けない", () => {
    const original = "まず最初に、彼は立ち上がった";
    const chunk = chunkOf(`${original}。`);
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original,
            suggestion: "",
            reason: "冗長",
            explanation: "『まず』と『最初に』が同じ意味です",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestionCleared).toBeUndefined();
  });
});
