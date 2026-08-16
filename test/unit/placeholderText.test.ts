import { describe, expect, test } from "vitest";
import { isPlaceholderText } from "../../src/core/placeholderText";
import { validateProofreadIssues } from "../../src/core/proofreadValidation";
import { validateTypoIssues } from "../../src/core/typoCheckValidation";
import type { Chunk } from "../../src/core/chunker";

/**
 * **AIが「中身が無い」ことを、中身として書いてくる。**
 *
 * 2026-08-17、作者の10作品で推敲を測っていて実際に返ってきた：
 *
 *     "original": "当然のことだが、帝国内の商会は相互に競争をしている。…",
 *     "suggestion": "空文字"
 *
 * 「適用」を押すと、**本文の一文が「空文字」という3文字に置き換わる。**
 * 原稿を壊さないという第一の決まりに触れるので、書き込む手前で止める。
 */
function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/x/episode_0001.txt",
    text,
    startLine: 0,
    hash: "h",
  } as Chunk;
}

describe("中身の無い言葉を見分ける", () => {
  test.each([
    "空文字",
    "空文字列",
    "（空）",
    "(空)",
    "null",
    "N/A",
    "n/a",
    "undefined",
    "変更なし",
    "修正不要",
    "特になし",
    "そのまま",
    "-",
    "―",
    // 前後に括弧や句点が付いて返ることがある
    "「空文字」",
    "空文字。",
  ])("中身が無いと見なす: %s", (text) => {
    expect(isPlaceholderText(text)).toBe(true);
  });

  test.each([
    "まず",
    "約10分",
    "受け取れる制度。",
    // **本物の直しを取りこぼさない**
    "血抜きや魔抜き",
  ])("本物の修正案は落とさない: %s", (text) => {
    expect(isPlaceholderText(text)).toBe(false);
  });

  test("「なし」は、置き換える範囲によって扱いが変わる", () => {
    // 誤字脱字は一部だけを置き換えるので、「無し」→「なし」は本物の直し
    expect(isPlaceholderText("なし")).toBe(false);
    // 推敲は一文まるごとを置き換える。一文が「なし」になることはない
    expect(isPlaceholderText("なし", true)).toBe(true);
  });
});

describe("推敲：中身の無い修正案は、指摘を残して修正案だけ空にする", () => {
  // 実データでこの原文に「空文字」が返ってきた（長命ハイエルフの投資運用）
  const line =
    "当然のことだが、帝国内の商会は相互に競争をしている。" +
    "同じ商興会に属している商会でさえ、商売敵といっていい。";

  test("「空文字」が本文へ書き込まれない", () => {
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: line,
            suggestion: "空文字",
            reason: "同語反復",
            explanation: "「商会」が繰り返されています",
            confidence: "medium",
          },
        ],
      },
      chunkOf(line)
    );

    expect(result.accepted).toHaveLength(1);
    // **指摘そのものは正しい。** 消すのは修正案だけ
    expect(result.accepted[0].suggestion).toBe("");
  });

  test("本物の修正案はそのまま通る", () => {
    const original = "それは〆た後すぐに血抜き魔抜きをしなかったせいだ。";
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original,
            suggestion: "それは〆た後すぐに血抜きや魔抜きをしなかったせいだ。",
            reason: "冗長",
            explanation: "「血抜き魔抜き」が続いています",
            confidence: "high",
          },
        ],
      },
      chunkOf(original)
    );

    expect(result.accepted[0].suggestion).toContain("血抜きや魔抜き");
  });
});

describe("誤字脱字：中身の無い修正案は、指摘ごと落とす", () => {
  // 誤字脱字には必ず直し方がある。無いなら、それは指摘ではない
  test("「空文字」を修正案にした指摘を弾く", () => {
    const text = "彼は歩いて行った。";
    const result = validateTypoIssues(
      {
        issues: [
          {
            line: 1,
            original: text,
            target: "歩いて",
            suggestion: "空文字",
            reason: "誤字",
            confidence: "high",
          },
        ],
      },
      chunkOf(text),
      []
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("placeholder_suggestion");
  });

  test("「無し」→「なし」のような本物の直しは通す", () => {
    const text = "問題は無しだ。";
    const result = validateTypoIssues(
      {
        issues: [
          {
            line: 1,
            original: text,
            target: "無し",
            suggestion: "なし",
            reason: "表記",
            confidence: "medium",
          },
        ],
      },
      chunkOf(text),
      []
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("なし");
  });
});
