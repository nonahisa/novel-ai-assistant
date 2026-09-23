import { describe, it, expect } from "vitest";
import { validateTypoIssues } from "../../src/core/typoCheckValidation";
import type { Chunk } from "../../src/core/chunker";

/**
 * 修正案そのものが、直しの形をしているか（設計書6.8.15）。
 *
 * **作者の指摘から**（2026-08-21）。「修正案が原文と同じ場合は表示しなくて
 * いいのではないでしょうか」。実データを見ると、AIは「直したい語」ではなく
 * 「その周りの文」を修正案に入れてくることが多い。
 *
 * ```
 * 原文  「相当なお金持ちらしく、恨みも」
 * 対象  「お金持ちらしく」
 * 修正案「相当なお金持ちらしく、恨みも」  ← 原文と同じ
 * ```
 *
 * 押しても何も変わらないうえ、当てれば二重になる。
 */

/** 1行の本文を器にする。行番号は1から数える */
function lineChunk(text: string): Chunk {
  return {
    filePath: "本文/001.txt",
    index: 0,
    text,
    startLine: 0,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "h1",
  };
}

function judge(
  line: string,
  issue: { original: string; target: string; suggestion: string }
) {
  const result = validateTypoIssues(
    {
      issues: [
        { line: 1, ...issue, reason: "誤変換", confidence: "high" },
      ],
    },
    lineChunk(line),
    [],
    []
  );
  return {
    accepted: result.accepted.length > 0,
    reason: result.rejected[0]?.reason,
  };
}

describe("修正案が原文のまま", () => {
  it("実データで出た形を弾く", () => {
    const line = "一族は相当なお金持ちらしく、恨みもかっていたのだろう。";
    expect(
      judge(line, {
        original: "相当なお金持ちらしく、恨みも",
        target: "お金持ちらしく",
        suggestion: "相当なお金持ちらしく、恨みも",
      })
    ).toMatchObject({ accepted: false, reason: "same_as_original" });
  });

  it("原文が対象そのものなら、足す直しは通す", () => {
    // 脱字の直しは対象へ文字を足す。ここまで弾いてはいけない
    expect(
      judge("彼は走つた。", {
        original: "走つた",
        target: "走つた",
        suggestion: "走った",
      })
    ).toMatchObject({ accepted: true });
  });
});

describe("Markdownの記号が入った修正案", () => {
  it("注釈であって直しではないので弾く", () => {
    // 当てると本文にアスタリスクが入る
    const line = "先生たちは校門にいなかった。";
    expect(
      judge(line, {
        original: "先生たちは校門にいなかった",
        target: "は",
        suggestion: "先生たち**は**校門にいなかった",
      }).accepted
    ).toBe(false);
  });
});

describe("対象より大幅に長い修正案", () => {
  it("文の書き換えは弾く", () => {
    // 実データで +7 / +12 / +18 / +23 / +26 の5件があり、すべて本文を壊した
    const line = "あんた力込めすぎだよ⁉　いったん止まりな！";
    expect(
      judge(line, {
        original: "あんた力込めすぎだよ",
        target: "あんた力込めすぎだよ",
        suggestion: "あんたは力を込めすぎだよ⁉　いったん止めな！",
      })
    ).toMatchObject({ accepted: false, reason: "rewrites_span" });
  });

  it("助詞を1つ足す直しは通す", () => {
    expect(
      judge("悪霊って、空飛べて壁もすり抜けられるのか。", {
        original: "空飛べて",
        target: "空飛べて",
        suggestion: "空を飛べて",
      })
    ).toMatchObject({ accepted: true });
  });

  it("実データで通った最大の伸び（+3）は通す", () => {
    // 上限は観測した最大に2文字の余裕を足して決めた。境界を固定する
    expect(
      judge("ばあさんが怖い。が、手鏡を渡されて納得した。", {
        original: "怖い。が、",
        target: "が、",
        suggestion: "しかし、",
      })
    ).toMatchObject({ accepted: true });
  });
});
