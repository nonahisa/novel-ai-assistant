import { describe, expect, test } from "vitest";
import { normalizeGender } from "../../src/core/gender";
import { mergeExtractedCharacters } from "../../src/core/characterMerge";
import { emptyCharacter } from "../../src/models/character";
import { CHARACTER_EXTRACT_SCHEMA } from "../../src/prompts/characterExtract";

describe("性別の表記を揃える", () => {
  test("男女は「男性」「女性」に統一する", () => {
    // AIは本文の言い方をそのまま返してくる。揃えないと、
    // 同じ人物が話ごとに「男」「男性」と揺れて食い違い扱いになる
    for (const value of ["男", "男の子", "少年", "オス", "male", "男性"]) {
      expect(normalizeGender(value)).toBe("男性");
    }
    for (const value of ["女", "女の子", "少女", "メス", "female", "女性"]) {
      expect(normalizeGender(value)).toBe("女性");
    }
  });

  test("男女以外は本文の記載のまま残す", () => {
    expect(normalizeGender("性別を持たない")).toBe("性別を持たない");
    expect(normalizeGender("両性")).toBe("両性");
  });

  test("知らない言い方を部分一致で書き換えない", () => {
    // 「男装の女性」を「男性」にすると意味が反転する
    expect(normalizeGender("男装の女性")).toBe("男装の女性");
    expect(normalizeGender("男とも女とも取れる")).toBe("男とも女とも取れる");
  });

  test("空欄は未設定にする", () => {
    expect(normalizeGender("   ")).toBeNull();
    expect(normalizeGender(null)).toBeNull();
    expect(normalizeGender(undefined)).toBeNull();
  });
});

describe("抽出結果の性別", () => {
  test("空欄なら埋める。表記も揃える", () => {
    const merged = mergeExtractedCharacters(
      [emptyCharacter("char_001", "灯")],
      [
        {
          data: { name: "灯", gender: "少女", evidence: "灯は言った" },
          chapters: [1],
        },
      ]
    );

    expect(merged.characters[0].gender).toBe("女性");
  });

  test("既にある値は上書きせず、食い違いとして残す", () => {
    // 設定側が正しいのか本文側が正しいのかはAIには判断できない
    const merged = mergeExtractedCharacters(
      [{ ...emptyCharacter("char_001", "灯"), gender: "女性" }],
      [
        {
          data: { name: "灯", gender: "男", evidence: "灯は言った" },
          chapters: [1],
        },
      ]
    );

    expect(merged.characters[0].gender).toBe("女性");
    expect(
      merged.characters[0].conflicts.some(
        (conflict) => conflict.field === "gender"
      )
    ).toBe(true);
  });

  test("表記違いだけでは食い違いにしない", () => {
    const merged = mergeExtractedCharacters(
      [{ ...emptyCharacter("char_001", "灯"), gender: "女性" }],
      [
        {
          data: { name: "灯", gender: "少女", evidence: "灯は言った" },
          chapters: [1],
        },
      ]
    );

    expect(merged.characters[0].conflicts).toHaveLength(0);
  });

  test("スキーマで必須にして、モデルが黙って落とすのを防ぐ", () => {
    expect(
      CHARACTER_EXTRACT_SCHEMA.properties.characters.items.required
    ).toEqual(expect.arrayContaining(["gender"]));
  });
});
