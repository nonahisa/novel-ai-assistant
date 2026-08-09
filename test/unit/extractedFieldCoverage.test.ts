import { describe, expect, test } from "vitest";
import {
  EXTRACTED_TEXT_FIELDS,
  normalizeExtractedCharacter,
} from "../../src/core/characterExtractionValidation";
import {
  normalizeExtractedAbility,
  normalizeExtractedLocation,
} from "../../src/core/settingsExtractionValidation";
import { CHARACTER_EXTRACT_SCHEMA } from "../../src/prompts/characterExtract";
import { mergeExtractedCharacters } from "../../src/core/characterMerge";
import { emptyCharacter } from "../../src/models/character";

/**
 * プロンプトが要求している項目が、抽出結果として最後まで届くかを固定する。
 *
 * `normalizeExtractedCharacter` は受け取る項目の白紙リストになっており、
 * **プロンプトに項目を足してもここに足し忘れると黙って捨てられる。**
 * AIは正しく返しているのに、画面では「AIが埋められなかった」ようにしか見えず、
 * プロンプトの書き方を疑って時間を溶かすことになる。
 * 実際に reading / summary / affiliation / gender の4つで起きた。
 */

/**
 * 個別に扱っているので白紙リストには載らない項目。
 * `name` は空にできない必須項目、`entityType` は決まった値のどれかで、
 * どちらも「空文字なら null」という単純な処理では済まない。
 */
const HANDLED_SEPARATELY = ["name", "entityType"];

/** スキーマ側で単純な文字列として定義されている項目 */
function schemaTextFields(): string[] {
  const properties = CHARACTER_EXTRACT_SCHEMA.properties.characters.items
    .properties as Record<string, { type?: unknown }>;

  return Object.entries(properties)
    .filter(([, definition]) => {
      const type = definition.type;
      if (type === "string") return true;
      return Array.isArray(type) && type.includes("string");
    })
    .map(([key]) => key)
    .filter((key) => !HANDLED_SEPARATELY.includes(key));
}

/** 能力・場所は個別に組み立てているので、鍵の集合を突き合わせる */
function schemaKeysOf(kind: "abilities" | "locations"): string[] {
  const properties = CHARACTER_EXTRACT_SCHEMA.properties[kind].items
    .properties as Record<string, unknown>;
  return Object.keys(properties).filter((key) => key !== "name");
}

describe("能力・場所も取りこぼさない", () => {
  test("スキーマの項目が、そのままレコードへ入る", () => {
    const ability = normalizeExtractedAbility({
      name: "神術",
      reading: "しんじゅつ",
      summary: "神の力を借りて奇跡を起こす術。",
      category: "神聖",
      description: "祈りによって発動する。",
      cost: "信仰心",
      limitation: "神殿の外では弱まる",
      userNames: ["灯"],
      evidence: "「神術よ」",
    });
    const location = normalizeExtractedLocation({
      name: "図書塔",
      reading: "としょとう",
      summary: "王都中央にそびえる魔導書庫。",
      region: "王都リヴェルス",
      description: "古い書物が眠る。",
      evidence: "図書塔の階段",
    });

    // 紹介が落ちていたことがある。項目ごとに見る
    expect(ability.summary).toBe("神の力を借りて奇跡を起こす術。");
    expect(location.summary).toBe("王都中央にそびえる魔導書庫。");

    for (const key of schemaKeysOf("abilities")) {
      expect(ability, `能力の ${key} が受け取れていません`).toHaveProperty(key);
    }
    for (const key of schemaKeysOf("locations")) {
      expect(location, `場所の ${key} が受け取れていません`).toHaveProperty(key);
    }
  });
});

describe("プロンプトの項目が抽出結果まで届く", () => {
  test("スキーマの文字列項目は、すべて正規化を通り抜ける", () => {
    const missing = schemaTextFields().filter(
      (key) => !(EXTRACTED_TEXT_FIELDS as readonly string[]).includes(key)
    );

    expect(
      missing,
      `プロンプトが要求しているのに受け取っていない項目: ${missing.join("、")}。` +
        "characterExtractionValidation.ts の EXTRACTED_TEXT_FIELDS に足してください。"
    ).toEqual([]);
  });

  test("受け取る項目に、スキーマに無いものを混ぜない", () => {
    const fields = schemaTextFields();
    const unknown = EXTRACTED_TEXT_FIELDS.filter(
      (key) => !fields.includes(key)
    );

    expect(unknown).toEqual([]);
  });

  test("AIが返した値が、そのまま人物レコードへ入る", () => {
    // 正規化・検証・マージを通して、端から端まで届くことを見る
    const merged = mergeExtractedCharacters(
      [emptyCharacter("char_001", "密倉 文佳")],
      [
        {
          data: normalizeExtractedCharacter({
            name: "密倉 文佳",
            reading: "みつくらふみか",
            summary: "転生して超絶美少女になった小学六年生。",
            affiliation: "久山小学校",
            gender: "女",
            role: "久山小学校六年生",
            personality: "状況を受け入れようとしている",
            appearance: "超絶美少女",
            evidence: "僕の名前は「密倉　文佳」",
          }),
          chapters: [5],
        },
      ]
    );

    const character = merged.characters[0];
    expect(character.reading).toBe("みつくらふみか");
    expect(character.summary).toBe("転生して超絶美少女になった小学六年生。");
    expect(character.affiliation).toBe("久山小学校");
    // 「女」は「女性」に揃える
    expect(character.gender).toBe("女性");
    expect(character.role).toBe("久山小学校六年生");
  });
});
