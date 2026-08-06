import { describe, expect, test } from "vitest";
import type { Chunk } from "../../src/core/chunker";
import {
  parseResult,
  validateCharacterExtractResult,
  type CharacterRejectionReason,
} from "../../src/core/characterExtractionValidation";
import type { CharacterExtractResult } from "../../src/prompts/characterExtract";

const sourceLine = "灯は静かに帰宅した";
const chunk: Chunk = {
  filePath: "001.txt",
  index: 0,
  text: `${sourceLine}。\n「シルさん、行こう」とエバンが呼んだ。\n衛兵Aは門を守った。`,
  startLine: 0,
  hash: "fixture",
  chapterStart: 1,
  chapterEnd: 1,
};

function validate(result: CharacterExtractResult, targetChunk = chunk) {
  return validateCharacterExtractResult(result, targetChunk);
}

describe("AI登場人物抽出結果の検証", () => {
  test.each<[
    string,
    "person" | "group" | "location" | "unknown" | undefined,
    CharacterRejectionReason,
  ]>([
    ["僕", undefined, "invalid_name"],
    ["先生", undefined, "non_person"],
    ["兵士たち", undefined, "collective"],
    ["王都アルバ", "location", "non_person"],
    ["灯は帰った。だから眠った", undefined, "invalid_name"],
    ["誰か", undefined, "invalid_name"],
    ["警官", undefined, "non_person"],
    ["村人ら", undefined, "collective"],
    ["灯は帰った", undefined, "invalid_name"],
    ["「灯」", undefined, "invalid_name"],
  ])("人物でない候補 %s を %s として除外する", (name, entityType, reason) => {
    const result = validate({
      characters: [{ name, entityType, evidence: sourceLine }],
    });

    expect(result.rejected).toEqual([{ name, reason }]);
    expect(result.accepted).toEqual([]);
  });

  test("本文中の名前が一致する人物を根拠ありとして通す", () => {
    const result = validate({
      characters: [
        {
          name: "灯",
          entityType: "person",
          evidence: "本文にはない説明",
        },
      ],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  test("4文字以上の引用が本文に一致する人物を根拠ありとして通す", () => {
    const result = validate({
      characters: [
        {
          name: "月島",
          entityType: "person",
          evidence: `存在しない根拠です。\n「${sourceLine}」`,
        },
      ],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  test("正式名がなくても正規化済みの別名が本文に一致すれば通す", () => {
    const result = validate(
      {
        characters: [
          {
            name: "黒木 玲司",
            aliases: ["  玲司さん  "],
            evidence: "本文にはない説明",
          },
        ],
      },
      {
        ...chunk,
        text: "「玲司さん、こちらへ」と灯が呼んだ。",
      }
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.aliases).toEqual(["玲司さん"]);
    expect(result.rejected).toEqual([]);
  });

  test("名前も引用も本文にない候補を根拠なしとして除外する", () => {
    const result = validate({
      characters: [
        {
          name: "月島",
          entityType: "person",
          evidence: "月島は塔へ向かった",
        },
      ],
    });

    expect(result.rejected).toEqual([
      { name: "月島", reason: "ungrounded" },
    ]);
    expect(result.accepted).toEqual([]);
  });

  test("名前をtrimし別名を重複なく正規化する", () => {
    const result = validate({
      characters: [
        {
          name: "  灯  ",
          aliases: ["  あかり ", "", "灯", "あかり"],
          evidence: sourceLine,
        },
      ],
    });

    expect(result.accepted[0].data).toMatchObject({
      name: "灯",
      aliases: ["あかり"],
      evidence: sourceLine,
    });
  });

  test("不正なネスト要素を捨て有効な呼称と関係だけを正規化する", () => {
    const result = validate({
      characters: [
        {
          name: "灯",
          evidence: sourceLine,
          addressTerms: [
            null,
            { targetName: "  澪 ", term: " 澪さん ", context: " 平時 " },
            { targetName: "", term: "君" },
          ],
          relations: [
            null,
            { name: " 澪 ", relation: " 友人 " },
            { name: "エバン", relation: "" },
          ],
        },
      ],
    } as unknown as CharacterExtractResult);

    expect(result.accepted[0].data.addressTerms).toEqual([
      {
        targetName: "澪",
        term: "澪さん",
        category: null,
        context: "平時",
        evidence: null,
      },
    ]);
    expect(result.accepted[0].data.relations).toEqual([
      { name: "澪", relation: "友人" },
    ]);
  });

  test("個別名のある背景人物はisMobを保持して通す", () => {
    const result = validate({
      characters: [
        {
          name: "衛兵A",
          entityType: "person",
          isMob: true,
        },
      ],
    });

    expect(result.accepted[0].data).toMatchObject({
      name: "衛兵A",
      entityType: "person",
      isMob: true,
    });
  });

  test.each(["伊達", "さくら", "こはる", "ジャンヌ・ダルク"])(
    "合理的な人物名 %s を禁止パターンと誤判定しない",
    (name) => {
      const result = validate({
        characters: [{ name, evidence: sourceLine }],
      });

      expect(result.accepted).toHaveLength(1);
      expect(result.rejected).toEqual([]);
    }
  );

  test("漢字の達が付く役割語は集団として除外する", () => {
    const result = validate({
      characters: [{ name: "兵士達", evidence: sourceLine }],
    });

    expect(result.rejected).toEqual([
      { name: "兵士達", reason: "collective" },
    ]);
  });

  test.each(["null", "あ".repeat(31), "灯、澪"])(
    "不正な人物名 %s を除外する",
    (name) => {
      const result = validate({
        characters: [{ name, evidence: sourceLine }],
      });

      expect(result.rejected).toEqual([{ name, reason: "invalid_name" }]);
    }
  );

  test("オブジェクトでない候補を不正な形として除外する", () => {
    const result = validate({
      characters: [42],
    } as unknown as CharacterExtractResult);

    expect(result.rejected).toEqual([
      { name: null, reason: "invalid_shape" },
    ]);
  });

  test.each([
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
    [4, 3],
  ])("不正な話数範囲 %s〜%s を展開しない", (chapterStart, chapterEnd) => {
    const result = validate(
      { characters: [{ name: "灯" }] },
      { ...chunk, chapterStart, chapterEnd }
    );

    expect(result.accepted[0].chapters).toEqual([]);
  });

  test("正しい話数範囲を昇順に展開する", () => {
    const result = validate(
      { characters: [{ name: "灯" }] },
      { ...chunk, chapterStart: 2, chapterEnd: 4 }
    );

    expect(result.accepted[0].chapters).toEqual([2, 3, 4]);
  });

  test("JSON解析時は後から再検証できるよう未正規化の値を保持する", () => {
    const parsed = parseResult(
      `前置き\n\`\`\`json\n${JSON.stringify({
        characters: [{ name: "  灯  ", aliases: [" 灯 "] }],
      })}\n\`\`\``
    );

    expect(parsed).toEqual({
      characters: [{ name: "  灯  ", aliases: [" 灯 "] }],
    });
  });
});
