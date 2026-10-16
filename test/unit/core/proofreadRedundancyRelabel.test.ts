import { describe, expect, test } from "vitest";
import { validateProofreadIssues } from "../../../src/core/proofreadValidation";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 「冗長」の札で来た、文をまたぐ繰り返しを「同語反復」へ付け替える（設計書6.9.1）。
 *
 * 2026-10-16 の推敲の測り直し（ハイエルフ17話・gemma4:26b）で、第12話の台詞
 * 「…考えにくいのではないでしょうか？」が「冗長」の札・説明「『〜ではないでしょうか』が
 * 直前の文と重なっています」で通った。重なりの相手は**別の台詞**（7行前）にあり、
 * 冗長（同じ意味の語が1か所で重なる）ではなく同語反復である。同語反復なら台詞の中の
 * 繰り返しは人物の話し方として出さない（`dialogue_voice`）が、冗長の札にはその検査が無い。
 * 本文はそのまま入れず、同じ形の作り物で写した。
 */
function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/012.txt",
    index: 0,
    text,
    startLine: 10,
    chapterStart: 12,
    chapterEnd: 12,
    hash: "abc123",
    segments: [],
  } as unknown as Chunk;
}

function run(text: string, issue: Record<string, unknown>) {
  return validateProofreadIssues(
    { issues: [{ suggestion: "", confidence: "medium", ...issue }] },
    chunkOf(text)
  );
}

describe("冗長の札で来た、文をまたぐ繰り返し", () => {
  test("台詞どうしの語尾の繰り返しは、同語反復として人物の話し方で落ちる", () => {
    const text = [
      "「聞いてはいますが、それなら値は動かないはずではないでしょうか？」",
      "",
      "　先生は首をかしげる。",
      "",
      "「豆の出来も去年と同じですから、値が上がるとは思えないのではないでしょうか？」",
    ].join("\n");
    const result = run(text, {
      line: 15,
      original: "値が上がるとは思えないのではないでしょうか？",
      reason: "冗長",
      explanation: "「〜ではないでしょうか」が直前の文と重なっています",
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("dialogue_voice");
  });

  test("実データの形（重なりが3段落前の台詞）は、同語反復の近さにも当たらず出さない", () => {
    const text = [
      "「聞いてはいますが、それなら値は動かないはずではないでしょうか？」",
      "",
      "　先生はきょとんとする。",
      "",
      "「と、いいますと？？」",
      "",
      "「豆の出来も去年と同じですから、値が上がるとは思えないのではないでしょうか？」",
    ].join("\n");
    const result = run(text, {
      line: 17,
      original: "値が上がるとは思えないのではないでしょうか？",
      reason: "冗長",
      explanation: "「〜ではないでしょうか」が直前の文と重なっています",
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("not_repeated");
  });

  test("地の文どうしなら、同語反復の札で通る", () => {
    const text = [
      "　市場の値は、この冬のうちに落ち着くのではないでしょうか。",
      "　豆の出来も去年と同じで、値が上がるとは思えないのではないでしょうか。",
    ].join("\n");
    const result = run(text, {
      line: 12,
      original: "値が上がるとは思えないのではないでしょうか。",
      reason: "冗長",
      explanation: "「〜ではないでしょうか」が直前の文と重なっています",
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].reason).toBe("同語反復");
  });
});

describe("本物の冗長は付け替えない", () => {
  test("同じ意味の2語（まず最初に）は、片方が近くにもう一度出ても冗長のまま", () => {
    const text = "まず最初に、彼は立ち上がった。\n最初に見えたのは海だった。";
    const result = run(text, {
      line: 11,
      original: "まず最初に、彼は立ち上がった。",
      suggestion: "まず、彼は立ち上がった。",
      reason: "冗長",
      explanation: "「まず」と「最初に」が同じ意味です",
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].reason).toBe("冗長");
  });

  test("範囲の中で重なっている語（しながらしながら）は冗長のまま", () => {
    const text = "悶絶しながらしながら沼ワニに近づくと、槍が折れた。\n俺はしながら考えた。";
    const result = run(text, {
      line: 11,
      original: "悶絶しながらしながら沼ワニに近づくと、",
      suggestion: "悶絶しながら沼ワニに近づくと、",
      reason: "冗長",
      explanation: "「しながら」が重複しています",
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].reason).toBe("冗長");
  });

  test("1文の中の2つの語（取り出した…取り出す）は、近くに同じ語があっても冗長のまま", () => {
    const text =
      "カバンから取り出したパンを取り出すと、彼女は笑った。\n棚から皿を取り出した。";
    const result = run(text, {
      line: 11,
      original: "カバンから取り出したパンを取り出すと、",
      reason: "冗長",
      explanation: "「取り出した」と「取り出す」が重なっています",
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].reason).toBe("冗長");
  });
});
