import { describe, expect, test } from "vitest";
import {
  customFieldSetToJson,
  fieldsFor,
  parseCustomFieldSet,
  withFieldsFor,
  type CustomFieldDefinition,
} from "../../../src/models/customField";
import { emptyLocation, parseLocation } from "../../../src/models/location";
import { parseOrganization } from "../../../src/models/organization";
import { parseAbility } from "../../../src/models/ability";
import { parseWorldItem } from "../../../src/models/world";
import {
  applyAbilityEdits,
  applyLocationEdits,
  applyOrganizationEdits,
  applyWorldItemEdits,
  toRecordEdits,
} from "../../../src/core/settingsEdit";
import {
  abilitySchema,
  locationSchema,
  organizationSchema,
  worldSchema,
} from "../../../src/core/settingsSchema";
import { buildLocationMarkdown } from "../../../src/core/settingsMarkdown";

/**
 * 「一覧に項目を増やす」を人物以外の資料へ広げる（作者の裁定、2026-09-23 問11 B）。
 *
 * 項目の定義は `設定/custom_fields.json` に1つ。**人物の定義（`fields`）の
 * 置き方は変えない**——これまでのファイルを読めなくすると、作者が足した
 * 項目がまるごと消えて見える。人物以外は `byKind` に種類ごとに持つ。
 */

function definition(key: string, label: string): CustomFieldDefinition {
  return { key, label, hint: "", multiline: false };
}

describe("種類ごとの項目の定義", () => {
  test("人物の定義はこれまでどおり fields から読む", () => {
    const set = parseCustomFieldSet({
      fields: [{ key: "field_001", label: "誕生日" }],
    });
    expect(fieldsFor(set, "character").map((field) => field.label)).toEqual([
      "誕生日",
    ]);
    // 人物以外は、まだ何も無い
    expect(fieldsFor(set, "location")).toEqual([]);
  });

  test("場所・組織などの定義は byKind から読む", () => {
    const set = parseCustomFieldSet({
      fields: [],
      byKind: {
        location: [{ key: "field_001", label: "気候" }],
        organization: [{ key: "field_001", label: "設立年" }],
      },
    });
    expect(fieldsFor(set, "location").map((field) => field.label)).toEqual([
      "気候",
    ]);
    // **同じキーが種類をまたいでも衝突しない**（値は別々のレコードに入る）
    expect(fieldsFor(set, "organization")[0].key).toBe("field_001");
    expect(fieldsFor(set, "ability")).toEqual([]);
  });

  test("壊れた byKind は直さずに止める", () => {
    expect(() => parseCustomFieldSet({ fields: [], byKind: "気候" })).toThrow();
    expect(() =>
      parseCustomFieldSet({ fields: [], byKind: { location: "気候" } })
    ).toThrow();
    expect(() =>
      parseCustomFieldSet({
        fields: [],
        byKind: {
          location: [
            { key: "field_001", label: "気候" },
            { key: "field_001", label: "人口" },
          ],
        },
      })
    ).toThrow();
    // 知らない種類は、黙って捨てずに止める（綴りの誤りで定義が消えて見える）
    expect(() =>
      parseCustomFieldSet({
        fields: [],
        byKind: { locaton: [{ key: "field_001", label: "気候" }] },
      })
    ).toThrow();
  });

  test("人物だけのファイルは、書き出しても byKind を持たない（今のファイルの形のまま）", () => {
    const set = parseCustomFieldSet({
      fields: [{ key: "field_001", label: "誕生日" }],
    });
    expect(Object.keys(customFieldSetToJson(set))).toEqual([
      "schemaVersion",
      "fields",
    ]);
  });

  test("種類を指定して定義を差し替える。ほかの種類には触らない", () => {
    const base = parseCustomFieldSet({
      fields: [{ key: "field_001", label: "誕生日" }],
    });
    const next = withFieldsFor(base, "location", [
      definition("field_001", "気候"),
    ]);
    expect(fieldsFor(next, "character").map((field) => field.label)).toEqual([
      "誕生日",
    ]);
    expect(customFieldSetToJson(next)).toEqual({
      schemaVersion: base.schemaVersion,
      fields: [definition("field_001", "誕生日")],
      byKind: { location: [definition("field_001", "気候")] },
    });
    // 最後の1つを外したら、空の種類は書き出さない
    const cleared = withFieldsFor(next, "location", []);
    expect(Object.keys(customFieldSetToJson(cleared))).toEqual([
      "schemaVersion",
      "fields",
    ]);
  });
});

describe("人物以外のレコードが持つ追加項目の値", () => {
  test("読み込みで値が残る。空の値は持たない", () => {
    const location = parseLocation({
      id: "loc_001",
      name: "王都",
      customFields: { field_001: "温暖", field_002: "  " },
    });
    expect(location.customFields).toEqual({ field_001: "温暖" });
  });

  test("値が1つも無ければ、キーごと持たない（保存のたびに今のファイルを書き換えない）", () => {
    const location = parseLocation({ id: "loc_001", name: "王都" });
    expect("customFields" in location).toBe(false);
    expect("customFields" in emptyLocation("loc_002", "港")).toBe(false);
  });

  test("文字列以外は受け付けない（壊れたJSONは直さない）", () => {
    expect(() =>
      parseLocation({ id: "loc_001", name: "王都", customFields: { a: 3 } })
    ).toThrow();
    expect(() =>
      parseOrganization({ id: "org_001", name: "ギルド", customFields: [] })
    ).toThrow();
  });

  test("組織・能力・世界観も同じく読める", () => {
    expect(
      parseOrganization({
        id: "org_001",
        name: "ギルド",
        customFields: { field_001: "百年前" },
      }).customFields
    ).toEqual({ field_001: "百年前" });
    expect(
      parseAbility({
        id: "abil_001",
        name: "神術",
        customFields: { field_001: "三度まで" },
      }).customFields
    ).toEqual({ field_001: "三度まで" });
    expect(
      parseWorldItem({
        id: "world_001",
        name: "詠唱の制約",
        customFields: { field_001: "古語" },
      }).customFields
    ).toEqual({ field_001: "古語" });
  });
});

describe("パネルからの書き換え", () => {
  test("場所に追加項目の値を書ける", () => {
    const location = parseLocation({ id: "loc_001", name: "王都" });
    const edited = applyLocationEdits(
      location,
      toRecordEdits({ "custom:field_001": "温暖" })
    );
    expect(edited.customFields).toEqual({ field_001: "温暖" });
  });

  test("全部空にしたらキーごと外す", () => {
    const location = parseLocation({
      id: "loc_001",
      name: "王都",
      customFields: { field_001: "温暖" },
    });
    const edited = applyLocationEdits(
      location,
      toRecordEdits({ "custom:field_001": "" })
    );
    expect("customFields" in edited).toBe(false);
  });

  test("追加項目を送らなかった保存は、値に触らない", () => {
    const location = parseLocation({
      id: "loc_001",
      name: "王都",
      customFields: { field_001: "温暖" },
    });
    const edited = applyLocationEdits(location, toRecordEdits({ region: "北" }));
    expect(edited.customFields).toEqual({ field_001: "温暖" });
  });

  test("組織・能力・世界観も書ける", () => {
    const edits = toRecordEdits({ "custom:field_001": "値" });
    expect(
      applyOrganizationEdits(
        parseOrganization({ id: "org_001", name: "ギルド" }),
        edits
      ).customFields
    ).toEqual({ field_001: "値" });
    expect(
      applyAbilityEdits(parseAbility({ id: "abil_001", name: "神術" }), edits)
        .customFields
    ).toEqual({ field_001: "値" });
    expect(
      applyWorldItemEdits(
        parseWorldItem({ id: "world_001", name: "詠唱の制約" }),
        edits
      ).customFields
    ).toEqual({ field_001: "値" });
  });
});

describe("設定資料集（Markdown）", () => {
  test("場所の追加項目を、定義の見出しで出す。値の無い項目は出さない", () => {
    const markdown = buildLocationMarkdown(
      [
        parseLocation({
          id: "loc_001",
          name: "王都",
          customFields: { field_001: "温暖" },
        }),
      ],
      {
        workTitle: "作品",
        customFieldsByKind: {
          location: [definition("field_001", "気候"), definition("field_002", "人口")],
        },
      }
    );
    expect(markdown).toContain("- **気候**: 温暖");
    expect(markdown).not.toContain("人口");
  });
});

describe("外部のAIへ渡すスキーマ", () => {
  test("人物以外にも customFields が載っている（載っていないと外のAIが書けない）", () => {
    for (const schema of [
      abilitySchema(),
      organizationSchema(),
      locationSchema(),
      worldSchema(),
    ]) {
      expect(
        Object.keys(schema.properties as Record<string, unknown>)
      ).toContain("customFields");
    }
  });
});
