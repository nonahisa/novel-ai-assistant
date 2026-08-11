import { describe, expect, test } from "vitest";
import {
  buildAbilityMarkdown,
  buildCharacterMarkdown,
  buildLocationMarkdown,
  describeConflictValues,
  formatChapters,
} from "../../src/core/settingsMarkdown";
import { emptyAbility, emptyAbilitySystem } from "../../src/models/ability";
import { emptyLocation } from "../../src/models/location";
import { emptyCharacter } from "../../src/models/character";

const options = { workTitle: "図書塔の魔女" };

describe("登場話の表記", () => {
  test.each([
    [[1], "第1話"],
    [[1, 2], "第1、2話"],
    [[1, 2, 3], "第1〜3話"],
    [[1, 2, 3, 7], "第1〜3、7話"],
    [[5, 1, 3, 2], "第1〜3、5話"],
    [[3, 3, 4], "第3、4話"],
  ])("%j を %s と書く", (chapters, expected) => {
    expect(formatChapters(chapters)).toBe(expected);
  });

  test("空なら何も書かない", () => {
    expect(formatChapters([])).toBe("");
  });
});

describe("能力一覧", () => {
  test("作品の総称を見出しに使う", () => {
    const system = { ...emptyAbilitySystem(), abilityTerm: "神術" };
    const ability = { ...emptyAbility("abil_001", "灯火"), appearedChapters: [3] };

    const md = buildAbilityMarkdown([ability], system, options);

    // 現代ものに「魔法一覧」と出ないよう、総称は作品側の呼称を使う
    expect(md).toContain("# 図書塔の魔女 神術一覧");
    expect(md).not.toContain("魔法一覧");
  });

  test("効果・代償・制約・使い手を並べる", () => {
    const ability = {
      ...emptyAbility("abil_001", "灯火"),
      reading: "ともしび",
      description: "指先に光を灯す",
      cost: "微量の魔力",
      limitation: "強い光源の下では発動しない",
      userNames: ["灯", "澪"],
      appearedChapters: [3, 12],
    };

    const md = buildAbilityMarkdown([ability], emptyAbilitySystem(), options);

    expect(md).toContain("### 灯火（ともしび）");
    expect(md).toContain("- **効果**: 指先に光を灯す");
    expect(md).toContain("- **代償**: 微量の魔力");
    expect(md).toContain("- **制約**: 強い光源の下では発動しない");
    expect(md).toContain("- **使い手**: 灯、澪");
    expect(md).toContain("- **登場話**: 第3、12話");
  });

  test("分類ごとに見出しを立て、未分類を末尾へ置く", () => {
    const abilities = [
      { ...emptyAbility("abil_001", "灯火"), category: "光属性" },
      { ...emptyAbility("abil_002", "無名"), category: null },
      { ...emptyAbility("abil_003", "氷刃"), category: "水属性" },
    ];

    const md = buildAbilityMarkdown(abilities, emptyAbilitySystem(), options);

    expect(md.indexOf("## 光属性")).toBeLessThan(md.indexOf("## 水属性"));
    expect(md.indexOf("## 水属性")).toBeLessThan(md.indexOf("## 分類なし"));
  });

  test("作者の判断待ちを黙って捨てない", () => {
    const ability = {
      ...emptyAbility("abil_001", "灯火"),
      conflicts: [
        { field: "cost", values: ["魔力", "詠唱3秒"], chapters: [], note: null },
      ],
    };

    const md = buildAbilityMarkdown([ability], emptyAbilitySystem(), options);

    expect(md).toContain("変化かもしれない（cost）");
    expect(md).toContain("魔力 / 詠唱3秒");
  });

  test("公開範囲を超える項目を出さない", () => {
    const abilities = [
      emptyAbility("abil_001", "灯火"),
      { ...emptyAbility("abil_002", "禁呪"), spoilerLevel: "author_only" as const },
    ];

    const md = buildAbilityMarkdown(abilities, emptyAbilitySystem(), {
      ...options,
      spoilerLevel: "public",
    });

    expect(md).toContain("灯火");
    expect(md).not.toContain("禁呪");
  });
});

describe("場所一覧", () => {
  test("地域ごとにまとめ、地域未設定を末尾へ置く", () => {
    const locations = [
      { ...emptyLocation("loc_001", "図書塔"), region: "王都リヴェルス" },
      { ...emptyLocation("loc_002", "森の泉"), region: null },
      { ...emptyLocation("loc_003", "港"), region: "海辺の町" },
    ];

    const md = buildLocationMarkdown(locations, options);

    expect(md.indexOf("## 王都リヴェルス")).toBeGreaterThan(-1);
    expect(md.indexOf("## 地域未設定")).toBeGreaterThan(
      md.indexOf("## 海辺の町")
    );
  });

  test("説明と登場話を並べる", () => {
    const location = {
      ...emptyLocation("loc_001", "図書塔"),
      description: "王都中央にそびえる魔導書庫",
      appearedChapters: [1, 3],
    };

    const md = buildLocationMarkdown([location], options);

    expect(md).toContain("### 図書塔");
    expect(md).toContain("- **説明**: 王都中央にそびえる魔導書庫");
    expect(md).toContain("- **登場話**: 第1、3話");
  });
});

describe("登場人物一覧", () => {
  test("呼び分けを相手ごとに残す", () => {
    const character = {
      ...emptyCharacter("char_001", "月島 灯"),
      addressTerms: [
        {
          targetName: "白瀬 澪",
          targetId: null,
          authorLocked: false,
          forms: [
            {
              term: "白瀬さん",
              category: null,
              context: "距離がある時期",
              firstChapter: 1,
              lastChapter: 7,
              status: "past" as const,
              evidence: null,
            },
            {
              term: "澪",
              category: null,
              context: null,
              firstChapter: 8,
              lastChapter: null,
              status: "current" as const,
              evidence: null,
            },
          ],
        },
      ],
    };

    const md = buildCharacterMarkdown([character], options);

    // 呼び分けそのものが管理対象なので、1つにまとめない
    expect(md).toContain("**白瀬 澪への呼称**");
    expect(md).toContain("白瀬さん（第1〜7話）／距離がある時期（現在は使われない）");
    expect(md).toContain("澪（第8話〜）");
  });

  test("モブは末尾へまとめる", () => {
    const characters = [
      { ...emptyCharacter("char_001", "灯"), isMob: false },
      { ...emptyCharacter("char_002", "兵士たち"), isMob: true },
    ];

    const md = buildCharacterMarkdown(characters, options);

    // ネームドキャラを探す妨げにしない
    expect(md.indexOf("## 灯")).toBeLessThan(md.indexOf("## モブ・集団"));
    expect(md).toContain("- 兵士たち");
  });

  test("能力の習得状況を添える", () => {
    const character = {
      ...emptyCharacter("char_001", "灯"),
      abilities: [
        {
          abilityId: "abil_001",
          name: "灯火",
          mastery: "習得済み" as const,
          note: null,
          firstChapter: 3,
          appearedChapters: [3],
          evidence: null,
          autoGenerated: true,
        },
        {
          abilityId: null,
          name: "業火",
          mastery: "喪失" as const,
          note: null,
          firstChapter: null,
          appearedChapters: [],
          evidence: null,
          autoGenerated: true,
        },
      ],
    };

    const md = buildCharacterMarkdown([character], options);

    expect(md).toContain("- **能力**: 灯火、業火（喪失）");
  });

  test("何も無ければその旨を書く", () => {
    expect(buildCharacterMarkdown([], options)).toContain(
      "まだ登場人物が登録されていません"
    );
  });
});

describe("食い違いの表記", () => {
  test("値ごとの話数を並べて変化として読める形にする", () => {
    expect(
      describeConflictValues({
        field: "appearance",
        values: ["黒髪", "銀髪"],
        chapters: [],
        note: null,
        observations: [
          { value: "銀髪", chapters: [7, 8] },
          { value: "黒髪", chapters: [1, 2, 3] },
        ],
      })
    ).toBe("黒髪（第1〜3話）→ 銀髪（第7、8話）");
  });

  test("話数の記録が無い値は「それ以前」として先に置く", () => {
    expect(
      describeConflictValues({
        field: "appearance",
        values: ["黒髪", "銀髪"],
        chapters: [],
        note: null,
        observations: [
          { value: "黒髪", chapters: [] },
          { value: "銀髪", chapters: [7] },
        ],
      })
    ).toBe("黒髪（それ以前）→ 銀髪（第7話）");
  });

  test("値ごとの話数を持たない古いデータは値だけを並べる", () => {
    expect(
      describeConflictValues({
        field: "appearance",
        values: ["黒髪", "銀髪"],
        chapters: [1],
        note: null,
      })
    ).toBe("黒髪 / 銀髪");
  });
});
