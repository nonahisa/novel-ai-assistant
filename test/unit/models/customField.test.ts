import { describe, expect, test } from "vitest";
import {
  MAX_CUSTOM_FIELDS,
  customFieldSetToJson,
  fieldsFor,
  nextCustomFieldKey,
  parseCustomFieldSet,
  parseCustomFieldValues,
  restorableKeysFor,
  retiredKeysFor,
  validateNewField,
  withFieldRemoved,
  withFieldRestored,
  type CustomFieldDefinition,
} from "../../../src/models/customField";
import {
  applyCharacterEdits,
  editedCustomFields,
  toRecordEdits,
} from "../../../src/core/settingsEdit";
import { emptyCharacter, parseCharacter } from "../../../src/models/character";
import { diffCharacter } from "../../../src/core/characterDiff";
import { buildCharacterMarkdown } from "../../../src/core/settingsMarkdown";
import { describeCharacter } from "../../../src/core/settingsSummary";
import {
  buildEnrichSchema,
  enrichableFields,
} from "../../../src/prompts/settingsEnrich";

function definition(
  key: string,
  label: string,
  extra: Partial<CustomFieldDefinition> = {}
): CustomFieldDefinition {
  return { key, label, hint: "", multiline: false, ...extra };
}

describe("項目の定義", () => {
  test("見出しを変えても値が失われないよう、キーは連番にする", () => {
    // 見出しをそのままキーにすると、名前を直した瞬間に値と結び付かなくなる
    expect(nextCustomFieldKey([])).toBe("field_001");
    expect(nextCustomFieldKey([definition("field_001", "誕生日")])).toBe(
      "field_002"
    );
  });

  test("残っている定義の最大番号より後ろを振る", () => {
    const remaining = [definition("field_003", "身長")];
    expect(nextCustomFieldKey(remaining)).toBe("field_004");
  });

  test("いちばん後ろの項目を外してから足しても、外したキーを使い回さない", () => {
    // 使い回すと、各人物に残っている旧項目の値が、新しい項目の値として現れる
    // （作者の「誕生日」が「好物」の欄に紛れ込む）
    const before = parseCustomFieldSet({
      fields: [
        { key: "field_001", label: "身長" },
        { key: "field_002", label: "誕生日" },
      ],
    });
    const removed = withFieldRemoved(before, "character", "field_002");
    expect(fieldsFor(removed, "character").map((field) => field.key)).toEqual([
      "field_001",
    ]);
    expect(
      nextCustomFieldKey(
        fieldsFor(removed, "character"),
        retiredKeysFor(removed, "character")
      )
    ).toBe("field_003");
  });

  test("外したキーの記録は、保存して読み直しても残る", () => {
    const removed = withFieldRemoved(
      parseCustomFieldSet({ fields: [{ key: "field_001", label: "誕生日" }] }),
      "character",
      "field_001"
    );
    const reloaded = parseCustomFieldSet(
      JSON.parse(JSON.stringify(customFieldSetToJson(removed)))
    );
    // 定義が空になっても、外したキーは忘れない
    expect(fieldsFor(reloaded, "character")).toEqual([]);
    expect(retiredKeysFor(reloaded, "character")).toEqual(["field_001"]);
    expect(
      nextCustomFieldKey(
        fieldsFor(reloaded, "character"),
        retiredKeysFor(reloaded, "character")
      )
    ).toBe("field_002");
  });

  test("修正前に外した項目も、レコードに残っている値のキーから避ける", () => {
    // 修正前の版で外した項目は custom_fields.json に記録が無い。
    // 値は人物のファイルに残っているので、そのキーも使ったものとして数える
    expect(
      nextCustomFieldKey([definition("field_001", "身長")], ["field_002", "メモ"])
    ).toBe("field_003");
  });

  test("外したキーの記録は種類ごとに持ち、ほかの種類の採番に響かない", () => {
    const removed = withFieldRemoved(
      parseCustomFieldSet({
        fields: [],
        byKind: { location: [{ key: "field_001", label: "気候" }] },
      }),
      "location",
      "field_001"
    );
    expect(retiredKeysFor(removed, "location")).toEqual(["field_001"]);
    expect(retiredKeysFor(removed, "character")).toEqual([]);
    expect(customFieldSetToJson(removed)).toEqual({
      schemaVersion: "0.1",
      fields: [],
      retiredKeys: { location: ["field_001"] },
    });
  });

  test("外したことの無い作品では、ファイルの形を変えない", () => {
    // 新しい欄は中身のあるときだけ書く。何も外していない作品で
    // 保存のたびに差分が出ると、同期のたびに作者を惑わせる
    const set = parseCustomFieldSet({
      fields: [{ key: "field_001", label: "誕生日" }],
    });
    expect(Object.keys(customFieldSetToJson(set))).toEqual([
      "schemaVersion",
      "fields",
    ]);
  });

  test("壊れた外したキーの記録は直さずに止める", () => {
    expect(() =>
      parseCustomFieldSet({ fields: [], retiredKeys: ["field_001"] })
    ).toThrow();
    expect(() =>
      parseCustomFieldSet({ fields: [], retiredKeys: { character: "field_001" } })
    ).toThrow();
    expect(() =>
      parseCustomFieldSet({ fields: [], retiredKeys: { character: [1] } })
    ).toThrow();
    expect(() =>
      parseCustomFieldSet({ fields: [], retiredKeys: { charcter: ["field_001"] } })
    ).toThrow();
  });

  test("作者が手で定義を戻したときは、外したキーと重なっても拒まない", () => {
    // 記録は自動の採番を止めるためだけのもの。同じキーの定義を戻せば値も戻る
    const set = parseCustomFieldSet({
      fields: [{ key: "field_001", label: "誕生日" }],
      retiredKeys: { character: ["field_001"] },
    });
    expect(fieldsFor(set, "character")).toHaveLength(1);
    expect(nextCustomFieldKey(fieldsFor(set, "character"), retiredKeysFor(set, "character"))).toBe(
      "field_002"
    );
  });

  test("同じ名前は追加させない", () => {
    const existing = [definition("field_001", "誕生日")];
    expect(validateNewField(existing, "誕生日")).toContain("すでにあります");
    expect(validateNewField(existing, "身長")).toBeUndefined();
  });

  test("既定の項目名とぶつかる名前は断る", () => {
    // 通すと、追加項目の値が既定の項目を隠す
    expect(validateNewField([], "gender")).toContain("既定の項目名");
    expect(validateNewField([], "summary")).toContain("既定の項目名");
  });

  test("空の名前と長すぎる名前を断る", () => {
    expect(validateNewField([], "   ")).toContain("入力してください");
    expect(validateNewField([], "あ".repeat(21))).toContain("20字以内");
  });

  test("多すぎる項目を断る", () => {
    const many = Array.from({ length: MAX_CUSTOM_FIELDS }, (_, index) =>
      definition(`field_${index}`, `項目${index}`)
    );
    expect(validateNewField(many, "もう一つ")).toContain(
      `${MAX_CUSTOM_FIELDS}個まで`
    );
  });
});

describe("外した項目を戻す（2026-10-24 夜の作者の裁定）", () => {
  test("同じキーのまま定義へ戻し、外したキーの記録から消す", () => {
    // 同じキーで戻すので、各資料に残っている値がそのまま表に出る
    const removed = withFieldRemoved(
      parseCustomFieldSet({
        fields: [
          { key: "field_001", label: "身長" },
          { key: "field_002", label: "誕生日" },
        ],
      }),
      "character",
      "field_002"
    );
    const restored = withFieldRestored(
      removed,
      "character",
      definition("field_002", "誕生日", { hint: "本文から" })
    );
    expect(fieldsFor(restored, "character")).toEqual([
      definition("field_001", "身長"),
      definition("field_002", "誕生日", { hint: "本文から" }),
    ]);
    expect(retiredKeysFor(restored, "character")).toEqual([]);
    // 何も外していない作品と同じ形のファイルへ戻る
    expect(Object.keys(customFieldSetToJson(restored))).toEqual([
      "schemaVersion",
      "fields",
    ]);
  });

  test("戻したあとも、そのキーを次の項目へ振らない", () => {
    const restored = withFieldRestored(
      withFieldRemoved(
        parseCustomFieldSet({ fields: [{ key: "field_005", label: "誕生日" }] }),
        "character",
        "field_005"
      ),
      "character",
      definition("field_005", "誕生日")
    );
    expect(
      nextCustomFieldKey(
        fieldsFor(restored, "character"),
        retiredKeysFor(restored, "character")
      )
    ).toBe("field_006");
    // もう一度外せば、また記録に入る
    expect(
      retiredKeysFor(withFieldRemoved(restored, "character", "field_005"), "character")
    ).toEqual(["field_005"]);
  });

  test("ほかの種類の定義と記録には触らない", () => {
    const set = parseCustomFieldSet({
      fields: [],
      byKind: { location: [{ key: "field_001", label: "気候" }] },
      retiredKeys: { character: ["field_001"], location: ["field_002"] },
    });
    const restored = withFieldRestored(
      set,
      "location",
      definition("field_002", "人口")
    );
    expect(fieldsFor(restored, "location").map((field) => field.key)).toEqual([
      "field_001",
      "field_002",
    ]);
    expect(retiredKeysFor(restored, "location")).toEqual([]);
    expect(retiredKeysFor(restored, "character")).toEqual(["field_001"]);
    expect(fieldsFor(restored, "character")).toEqual([]);
  });

  test("戻せるのは、外したキーのうち定義に無いものだけ", () => {
    // 作者が custom_fields.json へ手で戻したキーは、もう戻す必要が無い
    const set = parseCustomFieldSet({
      fields: [{ key: "field_001", label: "誕生日" }],
      retiredKeys: { character: ["field_001", "field_003", "field_002"] },
    });
    expect(restorableKeysFor(set, "character")).toEqual([
      "field_003",
      "field_002",
    ]);
    expect(restorableKeysFor(set, "world")).toEqual([]);
  });

  test("外したキーでないものは戻さない（定義を勝手に増やさない）", () => {
    const set = parseCustomFieldSet({ fields: [] });
    expect(() =>
      withFieldRestored(set, "character", definition("field_009", "誕生日"))
    ).toThrow();
  });
});

describe("項目定義のJSON検証", () => {
  test("欠けた項目は既定値で補う", () => {
    const parsed = parseCustomFieldSet({
      fields: [{ key: "field_001", label: "誕生日" }],
    });
    expect(parsed.fields).toEqual([
      { key: "field_001", label: "誕生日", hint: "", multiline: false },
    ]);
  });

  test("壊れていたら勝手に直さず止める", () => {
    // 空として扱って上書きすると、作者が書いた定義がまるごと消える
    expect(() => parseCustomFieldSet({ fields: [{ key: "field_001" }] })).toThrow();
    expect(() => parseCustomFieldSet({ fields: "誕生日" })).toThrow();
    expect(() =>
      parseCustomFieldSet({
        fields: [
          { key: "field_001", label: "誕生日" },
          { key: "field_001", label: "身長" },
        ],
      })
    ).toThrow();
  });
});

describe("人物レコードが持つ追加項目の値", () => {
  test("空の値は持たない", () => {
    expect(
      parseCustomFieldValues({ field_001: "3月3日", field_002: "  " })
    ).toEqual({ field_001: "3月3日" });
  });

  test("文字列以外は受け付けない", () => {
    expect(() => parseCustomFieldValues({ field_001: 3 })).toThrow();
  });

  test("未設定なら空にする", () => {
    expect(parseCustomFieldValues(undefined)).toEqual({});
    expect(parseCharacter({ id: "char_001", name: "灯" }).customFields).toEqual(
      {}
    );
  });

  test("読み書きで値が残る", () => {
    const character = {
      ...emptyCharacter("char_001", "灯"),
      customFields: { field_001: "3月3日" },
    };
    expect(parseCharacter(character).customFields).toEqual({
      field_001: "3月3日",
    });
  });
});

describe("追加項目の書き換え", () => {
  test("空欄にすると値を消す", () => {
    expect(editedCustomFields({ field_001: "3月3日" }, { field_001: "" })).toEqual(
      {}
    );
  });

  test("画面に出ていない項目は巻き添えで消さない", () => {
    // 定義を外したあとも値だけ残る。保存のたびに消えると、
    // 項目を戻しても中身が空になっている
    const current = { field_001: "3月3日", field_009: "外した項目の値" };
    expect(editedCustomFields(current, { field_001: "3月4日" })).toEqual({
      field_001: "3月4日",
      field_009: "外した項目の値",
    });
  });

  test("作者が書き換えたら、以後の抽出で上書きされないようにする", () => {
    const edited = applyCharacterEdits(emptyCharacter("char_001", "灯"), {
      customFields: { field_001: "3月3日" },
    });
    expect(edited.customFields).toEqual({ field_001: "3月3日" });
    expect(edited.autoGenerated).toBe(false);
  });

  test("AIの提案を反映しただけなら作者確定にしない", () => {
    const edited = applyCharacterEdits(
      emptyCharacter("char_001", "灯"),
      { customFields: { field_001: "3月3日" } },
      { authorConfirmed: false }
    );
    expect(edited.autoGenerated).toBe(true);
  });
});

describe("画面から来たキーの振り分け", () => {
  test("custom: 付きだけを追加項目に回す", () => {
    expect(
      toRecordEdits({ role: "主人公", "custom:field_001": "3月3日" })
    ).toEqual({
      role: "主人公",
      customFields: { field_001: "3月3日" },
    });
  });

  test("追加項目が無ければ customFields を付けない", () => {
    // 空の {} を渡すと、渡されなかった項目まで触ったことになる
    expect(toRecordEdits({ role: "主人公" })).toEqual({ role: "主人公" });
  });
});

describe("追加項目の表示", () => {
  const fields = [
    definition("field_001", "誕生日"),
    definition("field_002", "口癖", { multiline: true }),
  ];
  const character = {
    ...emptyCharacter("char_001", "灯"),
    customFields: { field_001: "3月3日" },
  };

  test("設定資料集に、定義した順で出す", () => {
    const markdown = buildCharacterMarkdown([character], {
      workTitle: "作品",
      customFields: fields,
    });
    expect(markdown).toContain("- **誕生日**: 3月3日");
    // 値が無い項目は出さない。空の見出しが並ぶと読みにくい
    expect(markdown).not.toContain("口癖");
  });

  test("AIへ渡す現在の設定にも含める", () => {
    expect(describeCharacter(character, fields)).toContain("誕生日: 3月3日");
  });

  test("差分に見出しで出す", () => {
    const after = {
      ...character,
      customFields: { field_001: "3月4日" },
    };
    const diff = diffCharacter(character, after, fields);
    expect(diff.changes).toContainEqual({
      label: "誕生日",
      before: "3月3日",
      after: "3月4日",
    });
  });

  test("定義から外した項目の変化も見逃さない", () => {
    // 定義が無いからと差分に出さないと、気付けない書き換えになる
    const after = {
      ...character,
      customFields: { field_001: "3月3日", field_009: "増えた値" },
    };
    const diff = diffCharacter(character, after, fields);
    expect(diff.changes).toContainEqual({
      label: "field_009",
      before: "",
      after: "増えた値",
    });
  });
});

describe("AIへの項目提案", () => {
  const fields = [definition("field_001", "誕生日", { hint: "本文の記述から" })];

  test("人物には追加項目も提案させる", () => {
    const keys = enrichableFields("character", fields).map((field) => field.key);
    expect(keys).toContain("field_001");
    expect(keys).toContain("gender");
  });

  test("能力・場所には広げない", () => {
    expect(enrichableFields("ability", fields).map((f) => f.key)).not.toContain(
      "field_001"
    );
  });

  test("スキーマで必須にして、面倒な項目を落とさせない", () => {
    const schema = buildEnrichSchema("character", fields) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty("field_001");
    expect(schema.required).toContain("field_001");
  });
});
