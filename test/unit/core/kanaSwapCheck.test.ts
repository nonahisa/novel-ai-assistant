import { describe, expect, test } from "vitest";
import {
  KANA_SWAP_TABLE,
  adjacentSwapsOf,
  checkKanaSwaps,
  isSameFix,
} from "../../../src/core/kanaSwapCheck";
import type { Chunk } from "../../../src/core/chunker";

function makeChunk(text: string, startLine = 0): Chunk {
  return {
    filePath: "C:\\work\\001.txt",
    index: 0,
    text,
    startLine,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "hash-1",
  };
}

/**
 * 隣どうしの仮名の入れ替わり（設計書6.8.21。作者の依頼、2026-11-15）。
 *
 * 手元のAI（gemma4:e4b）は「もろちん」を素通りした。コードで照らす。
 */
describe("「もろちん」を「もちろん」へ直す指摘を出す", () => {
  test("地の文", () => {
    const findings = checkKanaSwaps(makeChunk("　露店の主人は、もろちん顔なじみだった。"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      line: 1,
      target: "もろちん",
      suggestion: "もちろん",
      confidence: "high",
    });
    // 当てる所を一意に決められるよう、前後の字を original に含める
    expect(findings[0].original).toContain("主人は、もろちん顔なじみ");
  });

  test("台詞", () => {
    const findings = checkKanaSwaps(makeChunk("「もろちん、鮮度は保証する」"));
    expect(findings.map((f) => f.target)).toEqual(["もろちん"]);
  });

  test("行番号は、チャンクの開始行から数える", () => {
    const findings = checkKanaSwaps(makeChunk("一行目。\n「もろちん疲れてるよ」", 10));
    expect(findings[0].line).toBe(12);
  });

  test("正しい「もちろん」は指摘しない", () => {
    expect(checkKanaSwaps(makeChunk("もちろん、二人は気づかなかった。"))).toEqual([]);
  });

  test("1行に2か所あれば2件", () => {
    const findings = checkKanaSwaps(makeChunk("もろちん行くよ。もろちんだとも。"));
    expect(findings).toHaveLength(2);
  });
});

describe("ほかのよく使う語の入れ替わりも拾う", () => {
  test.each([
    ["ありとがう。じゃあ", "ありとがう", "ありがとう"],
    ["すまみせん、細かいのが", "すまみせん", "すみません"],
    ["帰り道、いなきり雨が", "いなきり", "いきなり"],
    ["なるどほ。これが", "なるどほ", "なるほど"],
    ["とろこで、この日記", "とろこで", "ところで"],
    ["わらかないな", "わらかない", "わからない"],
    ["おはうよ……じゃなくて", "おはうよ", "おはよう"],
    ["やぱっり、疲れてる", "やぱっり", "やっぱり"],
  ])("「%s」", (text, target, suggestion) => {
    const findings = checkKanaSwaps(makeChunk(text));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ target, suggestion });
  });
});

/**
 * **誤検出の罠。** 入れ替わりの形が、本物の語やその一部になるもの。
 * 作者の作品の写し（約92万字）で実際に当たった形と、一覧を目で見て除いた形
 */
describe("本物の語に重なる形は指摘しない", () => {
  test.each([
    // 3字の語は載せていない（作者の作品で「かわした」に18件当たった）
    "矢をかわした。",
    "僕はやりすぎた？",
    "なだらかな坂",
    // 一覧から除いた形
    "何も変わらない。かわらないよ",
    "少なからず関わっている",
    "成功したかに見えた",
    "ほんとにうれしい",
    "しらばくれる",
    "やさいしか食べない",
    "それもできる",
    "ほんのもう少し",
    "鳥とかにくとか",
    "いなかかな",
  ])("「%s」", (text) => {
    expect(checkKanaSwaps(makeChunk(text))).toEqual([]);
  });

  test("一覧の形は、どれも4字以上で、一覧の語そのものではない", () => {
    const words = new Set(KANA_SWAP_TABLE.values());
    for (const [swapped, correct] of KANA_SWAP_TABLE) {
      expect([...swapped].length).toBeGreaterThanOrEqual(4);
      expect(words.has(swapped)).toBe(false);
      // 正しい語の、隣どうしを1か所入れ替えた形であること
      expect(adjacentSwapsOf(correct)).toContain(swapped);
    }
  });

  test("同じ仮名が並ぶ所は、入れ替えた形を作らない", () => {
    expect(adjacentSwapsOf("ぜんぜん")).not.toContain("ぜんぜん");
    expect(adjacentSwapsOf("やっぱり")).toEqual(["っやぱり", "やぱっり", "やっりぱ"]);
  });
});

describe("作者が守った語・固有名詞に重なる所は指摘しない", () => {
  test("直さない語（わざと書いた台詞）", () => {
    const findings = checkKanaSwaps(makeChunk("「もろちん、鮮度は保証する」"), {
      keepWords: ["もろちん"],
    });
    expect(findings).toEqual([]);
  });

  test("固有名詞の中にある並び", () => {
    const findings = checkKanaSwaps(makeChunk("とろこで村へ向かった。"), {
      protectedNames: ["とろこで村"],
    });
    expect(findings).toEqual([]);
  });

  test("守った語が同じ行の別の所にあっても、ほかの入れ替わりは指摘する", () => {
    const findings = checkKanaSwaps(makeChunk("とろこで村で、もろちん待つ。"), {
      protectedNames: ["とろこで村"],
    });
    expect(findings.map((f) => f.target)).toEqual(["もろちん"]);
  });

  test("1字の語では守らない（本文のほとんどが守られてしまう）", () => {
    const findings = checkKanaSwaps(makeChunk("もろちん"), { keepWords: ["ろ"] });
    expect(findings).toHaveLength(1);
  });
});

describe("isSameFix：同じ所を同じ形に直すか", () => {
  const code = { line: 2, target: "もろちん", suggestion: "もちろん" };

  test("AIが前後の字を抱えて返しても、同じ直しと見る", () => {
    expect(isSameFix(code, { line: 2, target: "もろちん、", suggestion: "もちろん、" })).toBe(true);
    expect(isSameFix({ line: 2, target: "もろちん、", suggestion: "もちろん、" }, code)).toBe(true);
  });

  test("行が違えば別", () => {
    expect(isSameFix(code, { ...code, line: 3 })).toBe(false);
  });

  test("直す先が違えば別", () => {
    expect(isSameFix(code, { line: 2, target: "もろちん", suggestion: "勿論" })).toBe(false);
  });

  test("重ならなければ別", () => {
    expect(isSameFix(code, { line: 2, target: "鮮度", suggestion: "新鮮さ" })).toBe(false);
  });
});
