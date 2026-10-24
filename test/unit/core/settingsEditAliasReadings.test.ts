import { describe, expect, test } from "vitest";
import {
  applyCharacterEdits,
  applyLocationEdits,
  formatAliasReadingsForEdit,
  SettingsEditError,
} from "../../../src/core/settingsEdit";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { emptyLocation } from "../../../src/models/location";

/**
 * 設定資料パネルで別名の読みを直す（設計書6.42.2）。
 *
 * - 欄は1行に1つ「別名=読み」。読めない行・別名に無い呼び名は止める
 * - 別名の欄で消した別名の読みは、一緒に消える
 * - AIの提案を採る経路（authorConfirmed: false）では書かない（作者のデータ）
 * - 別名から名前を選ぶ（入れ替え）と、読みも表記について回る
 */

function person(extra: Partial<Character> = {}): Character {
  return { ...emptyCharacter("char_001", "灯"), aliases: ["姫君", "白雲", "リオ"], ...extra };
}

describe("欄の形", () => {
  test("読みのある別名と、漢字を含む別名を並べる（仮名だけの別名は並べない）", () => {
    expect(formatAliasReadingsForEdit(person({ aliasReadings: { 白雲: "しらくも" } }))).toBe(
      "姫君=\n白雲=しらくも"
    );
  });
});

describe("書き換え", () => {
  test("「別名=読み」で別名の読みを持たせる。並べたままの「別名=」は読みなし", () => {
    const edited = applyCharacterEdits(person(), { aliasReadings: "姫君=ひめぎみ\n白雲=\n" });
    expect(edited.aliasReadings).toEqual({ 姫君: "ひめぎみ" });
  });

  test("全部空にすると欄ごと外す", () => {
    const edited = applyCharacterEdits(person({ aliasReadings: { 姫君: "ひめぎみ" } }), {
      aliasReadings: "姫君=",
    });
    expect("aliasReadings" in edited).toBe(false);
  });

  test("読めない行・別名に無い呼び名・名前は止める", () => {
    expect(() => applyCharacterEdits(person(), { aliasReadings: "ひめぎみ" })).toThrow(
      SettingsEditError
    );
    expect(() => applyCharacterEdits(person(), { aliasReadings: "殿下=でんか" })).toThrow(
      /別名にありません/
    );
    expect(() => applyCharacterEdits(person(), { aliasReadings: "灯=あかり" })).toThrow(
      /名前の読み/
    );
  });

  test("別名を消すと、その別名の読みも消える（同じ保存で欄に残っていても止めない）", () => {
    const before = person({ aliasReadings: { 姫君: "ひめぎみ", 白雲: "しらくも" } });
    const edited = applyCharacterEdits(before, {
      aliases: "白雲、リオ",
      aliasReadings: "姫君=ひめぎみ\n白雲=しらくも",
    });
    expect(edited.aliases).toEqual(["白雲", "リオ"]);
    expect(edited.aliasReadings).toEqual({ 白雲: "しらくも" });
    // 欄を送らない保存でも、別名を消せば読みは消える
    const only = applyCharacterEdits(before, { aliases: "姫君" });
    expect(only.aliasReadings).toEqual({ 姫君: "ひめぎみ" });
  });

  test("同じ保存で足した別名には、読みも書ける", () => {
    const edited = applyCharacterEdits(person(), {
      aliases: "姫君、白雲、リオ、北辰",
      aliasReadings: "北辰=ほくしん",
    });
    expect(edited.aliasReadings).toEqual({ 北辰: "ほくしん" });
  });

  test("AIの提案を採る経路では、別名の読みを書かない（いまの読みは残す）", () => {
    const before = person({ aliasReadings: { 姫君: "ひめぎみ" } });
    const edited = applyCharacterEdits(
      before,
      { summary: "灯台守の娘", aliasReadings: "姫君=ひめ\n白雲=はくうん" },
      { authorConfirmed: false }
    );
    expect(edited.aliasReadings).toEqual({ 姫君: "ひめぎみ" });
  });

  test("別名から名前を選ぶと、読みも表記について回る", () => {
    const before = person({ reading: "あかり", aliasReadings: { 姫君: "ひめぎみ" } });
    const edited = applyCharacterEdits(before, { name: "姫君", reading: "あかり" });
    expect(edited.name).toBe("姫君");
    expect(edited.reading).toBe("ひめぎみ");
    expect(edited.aliasReadings).toEqual({ 灯: "あかり" });
  });

  test("入れ替えと同じ保存で読みの欄を直していたら、作者の値が勝つ", () => {
    const before = person({ reading: "あかり", aliasReadings: { 姫君: "ひめぎみ" } });
    const edited = applyCharacterEdits(before, { name: "姫君", reading: "ひめさま" });
    expect(edited.reading).toBe("ひめさま");
  });

  test("場所でも同じに動く", () => {
    const place = { ...emptyLocation("loc_001", "霧ヶ峰"), aliases: ["北の峰", "峰"] };
    const edited = applyLocationEdits(place, { aliasReadings: "北の峰=きたのみね" });
    expect(edited.aliasReadings).toEqual({ 北の峰: "きたのみね" });
    const removed = applyLocationEdits(edited, { aliases: "峰" });
    expect("aliasReadings" in removed).toBe(false);
  });
});
