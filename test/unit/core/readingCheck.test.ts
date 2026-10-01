import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { validateCharacterExtractResult } from "../../../src/core/characterExtractionValidation";
import { isReadingInconsistentWithName } from "../../../src/core/readingCheck";
import type { CharacterExtractResult } from "../../../src/prompts/characterExtract";

/**
 * 読みの検算と、口調の根拠の取り違えの検算（作者の裁定、2026-10-01）。
 * 作り物の場面だけを使う。
 */

describe("読みが名前と合わないか", () => {
  test.each<[string, string]>([
    // 別名「自称天使」の読みが入った例
    ["叡智の天使", "じしょうてんし"],
    // 別名「マイナ先生」の読みが入った例（名前の仮名は読みに順に現れる）
    ["マイナ様", "まいなせんせい"],
  ])("「%s」に「%s」は合わない", (name, reading) => {
    expect(isReadingInconsistentWithName(name, reading)).toBe(true);
  });

  test.each<[string, string]>([
    ["叡智の天使", "えいちのてんし"],
    ["マイナ様", "まいなさま"],
    ["マイナ様", "マイナサマ"],
    ["お母さん", "おかあさん"],
    ["ルーシー", "るーしー"],
    ["ルーシー", "るうしい"],
    ["密倉文佳", "みつくらふみか"],
    ["ヒカリ", "ひかり"],
    ["桜の宮", "さくらのみや"],
  ])("「%s」に「%s」は通す", (name, reading) => {
    expect(isReadingInconsistentWithName(name, reading)).toBe(false);
  });

  test("判断の材料が無いものは通す（誤検出を避ける）", () => {
    // 漢字だけの名前は、読みを名前から確かめられない
    expect(isReadingInconsistentWithName("自称天使", "じしょうてんし")).toBe(false);
    // 英字を含む名前・仮名以外の読みは見ない
    expect(isReadingInconsistentWithName("Aの人", "えーのひと")).toBe(false);
    expect(isReadingInconsistentWithName("叡智の天使", "自称天使")).toBe(false);
    expect(isReadingInconsistentWithName("叡智の天使", "")).toBe(false);
  });
});

function chunkOf(text: string): Chunk {
  return {
    filePath: "001.txt",
    index: 0,
    text,
    startLine: 0,
    hash: "reading-check",
    chapterStart: 1,
    chapterEnd: 1,
  };
}

const BODY = [
  "叡智の天使は羽を広げた。",
  "マイナ様は静かに笑った。",
  "「ここは危ないぞ」とマイナは言った。",
  "「ええ、行きましょう」とターナは答えた。",
  "ターナは剣を取った。",
].join("\n");

describe("抽出の検算に読みの検算が入る", () => {
  test("合わない読みだけを外して記録し、人物は残す", () => {
    const result: CharacterExtractResult = {
      characters: [
        {
          name: "叡智の天使",
          entityType: "person",
          evidence: "叡智の天使は羽を広げた。",
          reading: "じしょうてんし",
        },
        {
          name: "マイナ様",
          entityType: "person",
          evidence: "マイナ様は静かに笑った。",
          reading: "まいなさま",
        },
      ],
    };
    const validated = validateCharacterExtractResult(result, chunkOf(BODY));

    expect(validated.accepted.map((entry) => entry.data.name)).toEqual([
      "叡智の天使",
      "マイナ様",
    ]);
    expect(validated.accepted[0].data.reading).toBeUndefined();
    expect(validated.accepted[1].data.reading).toBe("まいなさま");
    expect(validated.droppedReadings).toEqual([
      { characterName: "叡智の天使", reading: "じしょうてんし" },
    ]);
  });
});

describe("同じ根拠の台詞が別の人物の口調の根拠になっているとき", () => {
  const quote = "ここは危ないぞ";

  function twoWithSameQuote(): CharacterExtractResult {
    return {
      characters: [
        {
          name: "マイナ",
          entityType: "person",
          evidence: "「ここは危ないぞ」とマイナは言った。",
          speechStyle: "断定的な男言葉。語尾は「〜ぞ」",
          speechEvidence: quote,
        },
        {
          name: "ターナ",
          entityType: "person",
          evidence: "ターナは剣を取った。",
          speechStyle: "断定的な男言葉。語尾は「〜ぞ」",
          speechEvidence: quote,
        },
      ],
    };
  }

  test("どちらの口調の案も入れず、人物は残して記録する", () => {
    const validated = validateCharacterExtractResult(
      twoWithSameQuote(),
      chunkOf(BODY)
    );

    expect(validated.accepted.map((entry) => entry.data.name)).toEqual([
      "マイナ",
      "ターナ",
    ]);
    for (const entry of validated.accepted) {
      expect(entry.data.speechStyle).toBeUndefined();
      expect(entry.data.speechEvidence).toBeUndefined();
    }
    expect(
      validated.droppedSpeechStyles.map((d) => [d.characterName, d.reason])
    ).toEqual([
      ["マイナ", "shared_quote"],
      ["ターナ", "shared_quote"],
    ]);
  });

  test("根拠の台詞がそれぞれ違えば、今どおり通す", () => {
    const result = twoWithSameQuote();
    result.characters[1].speechEvidence = "ええ、行きましょう";
    const validated = validateCharacterExtractResult(result, chunkOf(BODY));

    expect(validated.accepted[0].data.speechStyle).toBeDefined();
    expect(validated.accepted[1].data.speechStyle).toBeDefined();
    expect(validated.droppedSpeechStyles).toEqual([]);
  });
});
