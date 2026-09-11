import { describe, expect, test } from "vitest";
import {
  buildContradictionTermIndex,
  createContradictionMaterial,
} from "../../src/core/contradictionMaterial";
import {
  describeCharacter,
  describeLocation,
  describeWorldItem,
} from "../../src/core/settingsSummary";
import { emptyCharacter, type Character } from "../../src/models/character";
import { emptyLocation, type Location } from "../../src/models/location";
import { emptyWorldItem, type WorldItem } from "../../src/models/world";
import type { RecordChange } from "../../src/models/jsonValidation";

/**
 * 矛盾検知へ渡す材料の組み立て（設計書6.10.3）。
 *
 * もとは `features/checkContradictions.ts` の中に閉じており、**外から一度も
 * 測れなかった**。ここで測るのは、実機で繰り返し問題になった3点である。
 *
 * - その話の時点で分かっていることだけを渡しているか（6.10.3）
 * - 本文に出てこない設定を渡していないか（渡すと「登場していない」を矛盾にする）
 * - 世界観が上限内なら**従来と1文字も変わらない**か（6.27.6の穴2）
 */

function change(field: string, value: string, chapters: number[]): RecordChange {
  return {
    field,
    value,
    chapters,
    timepointId: null,
    note: null,
    evidence: null,
    source: "extracted",
  };
}

function person(options: {
  id: string;
  name: string;
  aliases?: string[];
  role?: string | null;
  summary?: string | null;
  chapters?: number[];
  changes?: RecordChange[];
}): Character {
  return {
    ...emptyCharacter(options.id, options.name),
    aliases: options.aliases ?? [],
    role: options.role ?? null,
    summary: options.summary ?? null,
    appearedChapters: options.chapters ?? [],
    changes: options.changes ?? [],
  };
}

function place(options: {
  id: string;
  name: string;
  aliases?: string[];
  description?: string | null;
  chapters?: number[];
}): Location {
  return {
    ...emptyLocation(options.id, options.name),
    aliases: options.aliases ?? [],
    description: options.description ?? null,
    appearedChapters: options.chapters ?? [],
  };
}

function world(options: {
  id: string;
  name: string;
  description: string;
}): WorldItem {
  return {
    ...emptyWorldItem(options.id, options.name),
    description: options.description,
  };
}

/** 索引の組み方も本番と同じものを通す（別々に組むと食い違いに気づけない） */
function material(options: {
  people?: Character[];
  places?: Location[];
  worldItems?: WorldItem[];
  worldviewMax?: number;
}) {
  const people = options.people ?? [];
  const places = options.places ?? [];
  return createContradictionMaterial({
    people,
    places,
    worldItems: options.worldItems ?? [],
    index: buildContradictionTermIndex({ people, places }),
    worldviewMax: options.worldviewMax ?? 30000,
  });
}

describe("本文に出てくるものだけを渡す", () => {
  test("名前の出ない人物は載らない", () => {
    const akari = person({
      id: "char_001",
      name: "月島 灯",
      role: "定時制高校生",
    });
    const rei = person({ id: "char_002", name: "如月 玲", role: "担任教師" });

    const relevant = material({ people: [akari, rei] }).relevantFor(
      "月島は黙って鞄を持ち上げた。",
      null
    );

    // **組み立ては describeCharacter そのまま**（切り出しで1文字も変えない）
    expect(relevant.characters).toBe(describeCharacter(akari, []));
    expect(relevant.characters).not.toContain("如月");
    expect(relevant.hasAnything).toBe(true);
  });

  test("場所も、本文に出たものだけが載る", () => {
    const tower = place({
      id: "loc_001",
      name: "図書塔",
      description: "町のはずれに建つ",
    });
    const port = place({ id: "loc_002", name: "南港", description: "潮の匂い" });

    const relevant = material({ places: [tower, port] }).relevantFor(
      "図書塔の階段を上った。",
      null
    );

    expect(relevant.locations).toBe(describeLocation(tower));
    expect(relevant.locations).not.toContain("南港");
  });

  test("何も出てこなければ、材料は無いと答える", () => {
    const akari = person({ id: "char_001", name: "月島 灯" });

    const relevant = material({ people: [akari] }).relevantFor(
      "誰もいない廊下に雨の音だけが残っていた。",
      null
    );

    expect(relevant.characters).toBe("");
    expect(relevant.locations).toBe("");
    // 照らし合わせる相手が無いチャンクはAIへ送らない（材料なしで問うと作り出す）
    expect(relevant.hasAnything).toBe(false);
  });

  test("世界観が1件でもあれば、誰も出ていなくても材料になる", () => {
    const relevant = material({
      worldItems: [
        world({ id: "world_001", name: "詠唱の制約", description: "唱え終えるまで動けない" }),
      ],
    }).relevantFor("誰もいない廊下。", null);

    expect(relevant.characters).toBe("");
    expect(relevant.hasAnything).toBe(true);
  });
});

describe("その話の時点で分かっていることだけ（設計書6.10.3）", () => {
  /** 作者の環境で実際に起きた形（4話で判明する内容を3話で矛盾と言われた） */
  test("あとの話で判明した値は、前の話のチャンクには載らない", () => {
    const akari = person({
      id: "char_001",
      name: "月島 灯",
      summary: "主人公",
      role: "定時制高校生（退学扱い）",
      chapters: [1],
      changes: [change("role", "定時制高校生（退学扱い）", [4])],
    });
    const built = material({ people: [akari] });

    const atThird = built.relevantFor("月島は俯いたままだった。", 3);
    expect(atThird.characters).toContain("月島 灯");
    expect(atThird.characters).not.toContain("退学扱い");

    // 判明した話まで来れば出す
    const atFourth = built.relevantFor("月島は俯いたままだった。", 4);
    expect(atFourth.characters).toContain("退学扱い");
  });

  test("その話までに登場していない人物は渡さない", () => {
    const rei = person({
      id: "char_002",
      name: "如月 玲",
      role: "担任教師",
      chapters: [5],
    });

    const relevant = material({ people: [rei] }).relevantFor(
      "如月の名前だけが名簿に残っていた。",
      3
    );

    expect(relevant.characters).toBe("");
    expect(relevant.hasAnything).toBe(false);
  });

  test("巻き戻して何も残らない人物は、名前だけ送らない", () => {
    const akari = person({
      id: "char_001",
      name: "月島 灯",
      role: "定時制高校生",
      chapters: [1],
      // 名前と読み以外が、すべてあとの話で分かったもの
      changes: [change("role", "定時制高校生", [4])],
    });

    const relevant = material({ people: [akari] }).relevantFor(
      "月島は俯いたままだった。",
      3
    );

    // 名前しか残らない記録を送っても材料にならず、AIが「材料がある」と誤解する
    expect(relevant.characters).toBe("");
  });

  test("話数が分からないチャンクでは、巻き戻さない", () => {
    const akari = person({
      id: "char_001",
      name: "月島 灯",
      role: "定時制高校生（退学扱い）",
      chapters: [1],
      changes: [change("role", "定時制高校生（退学扱い）", [4])],
    });

    const relevant = material({ people: [akari] }).relevantFor(
      "月島は俯いたままだった。",
      null
    );

    expect(relevant.characters).toContain("退学扱い");
  });

  test("場所も、その話までに登場したものだけを渡す", () => {
    const tower = place({
      id: "loc_001",
      name: "図書塔",
      description: "町のはずれに建つ",
      chapters: [7],
    });

    expect(
      material({ places: [tower] }).relevantFor("図書塔を見上げた。", 3).locations
    ).toBe("");
  });
});

describe("世界観（設計書6.27.6の穴2）", () => {
  const items = [
    world({ id: "world_001", name: "詠唱の制約", description: "唱え終えるまで動けない" }),
    world({ id: "world_002", name: "銀貨の価値", description: "銀貨三枚が一日の宿代" }),
    world({ id: "world_003", name: "王都の門限", description: "日没で閉じる" }),
  ];

  test("上限内なら、全項目が元の並び順のまま入る", () => {
    const relevant = material({ worldItems: items }).relevantFor(
      "誰も彼もが黙って歩いていた。",
      3
    );

    // 従来の組み立て（map して join）と完全一致であること
    expect(relevant.worldview).toBe(items.map(describeWorldItem).join("\n\n"));
  });

  test("上限を超えたら切る", () => {
    const max = describeWorldItem(items[0]).length + 5;
    const relevant = material({ worldItems: items, worldviewMax: max }).relevantFor(
      "誰も彼もが黙って歩いていた。",
      3
    );

    expect(relevant.worldview.length).toBeLessThanOrEqual(max);
    // 全部は入らないが、材料が空になることはない
    expect(relevant.worldview.length).toBeGreaterThan(0);
    expect(relevant.worldview).not.toBe(items.map(describeWorldItem).join("\n\n"));
  });

  test("参照資料の見込みは、上限と全文の小さいほう", () => {
    const whole = items
      .map((item) => describeWorldItem(item).length + 2)
      .reduce((sum, length) => sum + length, 0);

    // 世界観が3項目しかない作品で上限いっぱいを確保すると、本文が痩せる
    expect(material({ worldItems: items }).referenceBudgetChars).toBe(whole);
    expect(material({ worldItems: items, worldviewMax: 100 }).referenceBudgetChars).toBe(
      100
    );
  });
});

describe("過去の場面を引く語（設計書6.74）", () => {
  test("本文に現れた表記そのものを返す", () => {
    const akari = person({
      id: "char_001",
      name: "月島 灯",
      aliases: ["灯くん"],
    });

    const names = material({ people: [akari] }).namesIn(
      "灯くんはもう帰ったよ、と母が言った。"
    );

    // 正式名称で引くと、本文が別名しか書いていないときに当たらない
    expect(names).toContain("灯くん");
    expect(names).not.toContain("月島 灯");
  });

  test("同じ語は1回だけ返す", () => {
    const akari = person({ id: "char_001", name: "月島 灯" });
    const tower = place({ id: "loc_001", name: "図書塔" });

    const names = material({ people: [akari], places: [tower] }).namesIn(
      "月島は図書塔へ向かった。図書塔の扉は開いていた。"
    );

    expect(names.filter((name) => name === "図書塔")).toHaveLength(1);
    // 種別で絞らない（人物も場所も、過去の場面を引く語としては同じ）
    expect(names).toEqual(["月島", "図書塔"]);
  });

  test("名前が1つも出なければ空", () => {
    const akari = person({ id: "char_001", name: "月島 灯" });
    expect(material({ people: [akari] }).namesIn("雨が降っていた。")).toEqual([]);
  });
});
