import { describe, expect, test } from "vitest";
import {
  buildAbilityListItems,
  buildCharacterListItems,
  buildLocationListItems,
  countMobs,
} from "../../src/core/settingsList";
import { emptyCharacter, type Character } from "../../src/models/character";
import { emptyAbility } from "../../src/models/ability";
import { emptyLocation } from "../../src/models/location";
import type { AiNote } from "../../src/models/aiNote";

function character(
  id: string,
  name: string,
  overrides: Partial<Character> = {}
): Character {
  return { ...emptyCharacter(id, name), ...overrides };
}

const note: AiNote = {
  id: "note_001",
  createdAt: "2026-08-09T00:00:00.000Z",
  topic: "生い立ち",
  text: "本文からはこう読める。",
  model: "gemma4:e4b",
  source: "chat",
};

describe("設定資料パネルの一覧", () => {
  test("モブは末尾へ回す", () => {
    const items = buildCharacterListItems([
      character("char_001", "兵士たち", { isMob: true }),
      character("char_002", "ホンゴー"),
      character("char_003", "冒険者たち", { isMob: true }),
      character("char_004", "シル"),
    ]);

    // ネームドキャラを探すときに、モブが間に挟まると見つけにくい
    expect(items.map((item) => item.name)).toEqual([
      "ホンゴー",
      "シル",
      "兵士たち",
      "冒険者たち",
    ]);
    expect(items.map((item) => item.isMob)).toEqual([false, false, true, true]);
  });

  test("モブ以外の並びは入れ替えない", () => {
    // 名前順に並べ替えると、抽出のたびに位置が変わって場所を覚えられない
    const items = buildCharacterListItems([
      character("char_001", "ワイズ"),
      character("char_002", "アベル"),
      character("char_003", "メアリー"),
    ]);

    expect(items.map((item) => item.name)).toEqual([
      "ワイズ",
      "アベル",
      "メアリー",
    ]);
  });

  test("モブが1件も無ければ区画の件数は0になる", () => {
    const items = buildCharacterListItems([
      character("char_001", "ホンゴー"),
      character("char_002", "シル"),
    ]);

    expect(countMobs(items)).toBe(0);
  });

  test("モブの件数を数えられる", () => {
    const items = buildCharacterListItems([
      character("char_001", "ホンゴー"),
      character("char_002", "兵士たち", { isMob: true }),
      character("char_003", "取調官たち", { isMob: true }),
    ]);

    expect(countMobs(items)).toBe(2);
  });

  test("補足には紹介・所属・掘り下げ件数を出す", () => {
    const items = buildCharacterListItems([
      character("char_001", "ホンゴー", {
        summary: "生活保護課のケースワーカー",
        affiliation: "冒険者ギルド",
        aiNotes: [note],
      }),
    ]);

    expect(items[0].sub).toBe(
      "生活保護課のケースワーカー / 冒険者ギルド / 掘り下げ1"
    );
  });

  test("紹介が無ければ役割で代える", () => {
    const items = buildCharacterListItems([
      character("char_001", "シル", { role: "受付嬢" }),
    ]);

    expect(items[0].sub).toBe("受付嬢");
  });

  test("補足に「モブ」とは書かない", () => {
    // 畳んだ区画そのものがモブだと示すので、1件ずつ書くと同じことの繰り返しになる
    const items = buildCharacterListItems([
      character("char_001", "兵士たち", { isMob: true, role: "衛兵" }),
    ]);

    expect(items[0].sub).toBe("衛兵");
    expect(items[0].isMob).toBe(true);
  });

  test("空の項目で区切りだけが並ばないようにする", () => {
    const items = buildCharacterListItems([character("char_001", "名無し")]);

    expect(items[0].sub).toBe("");
  });

  test("能力と場所にモブの区別は無い", () => {
    const abilities = buildAbilityListItems([
      { ...emptyAbility("abil_001", "神術"), category: "神術" },
    ]);
    const locations = buildLocationListItems([
      { ...emptyLocation("loc_001", "王都"), region: "中央" },
    ]);

    expect(abilities[0]).toEqual({
      id: "abil_001",
      name: "神術",
      sub: "神術",
      isMob: false,
    });
    expect(locations[0]).toEqual({
      id: "loc_001",
      name: "王都",
      sub: "中央",
      isMob: false,
    });
    expect(countMobs([...abilities, ...locations])).toBe(0);
  });
});
