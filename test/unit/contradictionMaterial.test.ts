import { describe, expect, test } from "vitest";
import {
  buildContradictionTermIndex,
  carryOverBodyText,
  createContradictionMaterial,
  describeMissedCharacters,
  promptVersionWithCarryOver,
  CARRY_OVER_MAX_CHAPTERS,
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

/*
  前の話に出た人物を引き継ぐ（設計書6.10.6）。

  **一人称で語る主人公は自分の名前を言わない。** その話では主人公の設定が
  材料に1つも載らず、AIは「照らし合わせる相手が無い」ので正しく黙る——
  作者の219話で44話（20%）がこの形だった。落ちた44話のうち33話は直前の話に
  載っていたので、**前の話の本文も一緒に索引へかければ拾える**見込みがある。

  **これは測るための口である。** 既定（引き継がない）の動きは1文字も
  変わらないことを、ここで見張る。
*/
describe("前の話に出た人物を引き継ぐ（設計書6.10.6）", () => {
  const haruto = person({
    id: "char_001",
    name: "相沢 春人",
    role: "配達員",
    chapters: [1, 2, 3, 4, 5],
  });
  /** 一人称の地の文だけの話。**主人公の名前が1度も出ない** */
  const narration = "俺は左の足首をかばいながら、坂を下りた。";

  test("既定（引き継がない）では、これまでと1文字も変わらない", () => {
    const built = material({ people: [haruto] });

    const before = built.relevantFor(narration, 4);
    // 省略したときと、空の指定を渡したときと、空文字を渡したときで揃う
    expect(before.characters).toBe("");
    expect(built.relevantFor(narration, 4, {})).toEqual(before);
    expect(built.relevantFor(narration, 4, { carryOverText: "" })).toEqual(
      before
    );
  });

  test("前の話にだけ名前が出る人物が載る", () => {
    const built = material({ people: [haruto] });

    const relevant = built.relevantFor(narration, 4, {
      carryOverText: "相沢はその朝も八時に局を出た。",
    });

    expect(relevant.characters).toContain("相沢 春人");
    expect(relevant.characters).toContain("配達員");
  });

  test("その話までに登場していない人物は、引き継いでも載らない", () => {
    // **`hasAppearedBy` は引き継ぎの後ろにある**（設計書6.10.3）。
    // 引き継ぎで絞り込みを飛び越えると、あとの話で出てくる人物の設定が
    // 前の話へ流れ込む
    const later = person({
      id: "char_002",
      name: "黒瀬 千夏",
      role: "窓口係",
      chapters: [7],
    });

    const relevant = material({ people: [later] }).relevantFor(narration, 4, {
      carryOverText: "黒瀬は窓口で判を押していた。",
    });

    expect(relevant.characters).toBe("");
  });

  test("引き継ぐ本文そのものは、材料のどの欄にも入らない", () => {
    // 増えるのは【登場人物設定】だけ。前の話の本文をプロンプトへ入れない
    const relevant = material({ people: [haruto] }).relevantFor(narration, 4, {
      carryOverText: "相沢はその朝も八時に局を出た。",
    });

    expect(relevant.characters).not.toContain("八時に局を出た");
    expect(relevant.locations).toBe("");
    expect(relevant.worldview).toBe("");
  });

  /*
    **場所は引き継がない**（0.70.5の判断）。場所は「その場面がどこか」を
    言う材料なので、前の話の場所を足すと**もう居ない場所の設定**と本文を
    突き合わせることになる。実測で穴が見つかっているのは人物だけである。
  */
  test("場所は引き継がない（人物だけ）", () => {
    const tower = place({
      id: "loc_001",
      name: "立花郵便局",
      description: "町の中心にある",
      chapters: [1, 2, 3, 4],
    });

    const relevant = material({ places: [tower] }).relevantFor(narration, 4, {
      carryOverText: "立花郵便局の窓口は朝から混んでいた。",
    });

    expect(relevant.locations).toBe("");
  });
});

describe("引き継ぐ本文の選び方（`carryOverBodyText`）", () => {
  const bodies = [
    { chapter: 1, text: "一話の本文" },
    { chapter: 2, text: "二話の本文" },
    { chapter: 3, text: "三話の本文" },
    { chapter: 4, text: "四話の本文" },
  ];

  test("直前の2話だけを、話の順に並べる", () => {
    const carried = carryOverBodyText({ bodies, chapter: 4, chapters: 2 });

    expect(carried.chapters).toEqual([2, 3]);
    expect(carried.text).toBe("二話の本文\n\n三話の本文");
  });

  test("0話・負の数・小数以下は引き継がない", () => {
    for (const chapters of [0, -1, -5, 0.5]) {
      expect(carryOverBodyText({ bodies, chapter: 4, chapters })).toEqual({
        chapters: [],
        text: "",
      });
    }
  });

  test("小数は切り捨てる（1.9話は1話）", () => {
    expect(
      carryOverBodyText({ bodies, chapter: 4, chapters: 1.9 }).chapters
    ).toEqual([3]);
  });

  /*
    **大きすぎる値は上限で止める。** 遡るほど「いまの場面に居ない人物」の
    設定が積み上がる。打ち間違いに気づかせるのは呼ぶ側の役目で、ここは
    最後の守りである。
  */
  test("上限（5話）を超えては遡らない", () => {
    const long = Array.from({ length: 20 }, (_, index) => ({
      chapter: index + 1,
      text: `第${index + 1}話`,
    }));

    expect(
      carryOverBodyText({ bodies: long, chapter: 20, chapters: 99 }).chapters
    ).toEqual([15, 16, 17, 18, 19]);
    expect(CARRY_OVER_MAX_CHAPTERS).toBe(5);
  });

  test("知らない値（NaN・Infinity）でも落ちない", () => {
    expect(
      carryOverBodyText({ bodies, chapter: 4, chapters: Number.NaN }).text
    ).toBe("");
    expect(
      carryOverBodyText({ bodies, chapter: 4, chapters: Number.POSITIVE_INFINITY })
        .chapters
    ).toEqual([]);
  });

  test("話数の読めないチャンクには引き継がない", () => {
    // 前後を決められないものに「前の話」は無い
    expect(carryOverBodyText({ bodies, chapter: null, chapters: 2 }).text).toBe(
      ""
    );
  });

  test("話数の読めない本文は、引き継ぐ側にも使わない", () => {
    const mixed = [...bodies, { chapter: null, text: "話数の読めない本文" }];

    expect(carryOverBodyText({ bodies: mixed, chapter: 4, chapters: 2 }).text)
      .not.toContain("話数の読めない本文");
  });

  test("第1話には引き継ぐものが無い", () => {
    expect(carryOverBodyText({ bodies, chapter: 1, chapters: 2 })).toEqual({
      chapters: [],
      text: "",
    });
  });

  /*
    **数えるのは話数であって、塊の数ではない。** 合本（1ファイルに何話も）は
    呼ぶ側が話ごとに分けて渡すので、同じ話数のものが複数あればまとめて採る。
  */
  test("同じ話数の本文が複数あれば、まとめて採る", () => {
    const split = [
      { chapter: 2, text: "二話の前半" },
      { chapter: 2, text: "二話の後半" },
      { chapter: 3, text: "三話の本文" },
    ];

    const carried = carryOverBodyText({ bodies: split, chapter: 4, chapters: 1 });
    expect(carried.chapters).toEqual([3]);

    const two = carryOverBodyText({ bodies: split, chapter: 4, chapters: 2 });
    expect(two.chapters).toEqual([2, 3]);
    expect(two.text).toBe("二話の前半\n\n二話の後半\n\n三話の本文");
  });

  test("話数が飛んでいても、ある中の前の話を採る", () => {
    const sparse = [
      { chapter: 1, text: "一話" },
      { chapter: 9, text: "九話" },
      { chapter: 12, text: "十二話" },
    ];

    expect(
      carryOverBodyText({ bodies: sparse, chapter: 12, chapters: 2 }).chapters
    ).toEqual([1, 9]);
  });
});

describe("引き継ぎをキャッシュの鍵へ混ぜる", () => {
  test("引き継がないときは、鍵をこれまでと同じままにする", () => {
    expect(promptVersionWithCarryOver("1.5:abc", "")).toBe("1.5:abc");
  });

  test("引き継いだ本文が変われば、鍵も変わる", () => {
    // 前の話を書き直すと、引き継ぐ人物が変わりうる
    expect(promptVersionWithCarryOver("1.5:abc", "相沢は坂を下りた")).not.toBe(
      promptVersionWithCarryOver("1.5:abc", "黒瀬は坂を下りた")
    );
  });

  test("同じ本文からは、同じ鍵が出る", () => {
    expect(promptVersionWithCarryOver("1.5:abc", "相沢は坂を下りた")).toBe(
      promptVersionWithCarryOver("1.5:abc", "相沢は坂を下りた")
    );
  });
});

/*
  **落としたことを言う**（設計書6.10.6）。

  材料に載るのは本文に名前が出た人物だけなので、一人称で語る話では主人公が
  落ちる。**穴は塞がない。塞がずに、落としたことを言うだけ**である——
  `characters` も `hasAnything` も、ここでは1文字も変わらない。
*/
describe("落とした人物を数える（設計書6.10.6）", () => {
  const haruto = person({
    id: "char_001",
    name: "相沢 春人",
    role: "窓口係",
    chapters: [1, 2, 3, 4],
  });
  const rei = person({
    id: "char_002",
    name: "如月 玲",
    role: "担任教師",
    chapters: [1, 2, 3, 4],
  });

  test("直前の話には出ているのに、この話で落ちた人物を挙げる", () => {
    const relevant = material({ people: [haruto, rei] }).relevantFor(
      "俺は窓口の椅子に座っていた。",
      4,
      { previousBodyText: "相沢は坂を下りた。如月も一緒だった。" }
    );

    // 名前が出ていないので、材料には載らない（ここは従来どおり）
    expect(relevant.characters).toBe("");
    // 落としたことだけを言う
    expect(relevant.missedCharacters).toEqual(["相沢 春人", "如月 玲"]);
  });

  test("本文に名前が出ていれば、落ちていない", () => {
    const relevant = material({ people: [haruto, rei] }).relevantFor(
      "相沢は窓口の椅子に座っていた。",
      4,
      { previousBodyText: "相沢は坂を下りた。" }
    );

    expect(relevant.characters).toBe(describeCharacter(haruto, []));
    expect(relevant.missedCharacters).toEqual([]);
  });

  /*
    **引き継ぎが効いている回では空になる。** 引き継いだ人物は材料に載るので
    落ちていない——「穴を塞いだ」と「落としたと言う」が二重に出ない。
  */
  test("引き継いだ人物は、落としたとは言わない", () => {
    const relevant = material({ people: [haruto] }).relevantFor(
      "俺は窓口の椅子に座っていた。",
      4,
      {
        carryOverText: "相沢は坂を下りた。",
        previousBodyText: "相沢は坂を下りた。",
      }
    );

    expect(relevant.characters).toBe(describeCharacter(haruto, []));
    expect(relevant.missedCharacters).toEqual([]);
  });

  /*
    **話数で外した人は「落とした」と言わない**（設計書6.10.3）。その話の
    時点でまだ分かっていないから外したのであって、名前が出ないせいでは
    ない。ここを緩めると、まだ登場していない人物が毎回並ぶ。
  */
  test("その話の時点でまだ登場していない人物は、数えない", () => {
    const later = person({
      id: "char_003",
      name: "黒瀬 澪",
      role: "転校生",
      chapters: [9],
    });

    const relevant = material({ people: [later] }).relevantFor(
      "俺は窓口の椅子に座っていた。",
      4,
      { previousBodyText: "黒瀬は坂を下りた。" }
    );

    expect(relevant.missedCharacters).toEqual([]);
  });

  test("直前の話を渡さなければ、何も言わない（既定の呼び方）", () => {
    const relevant = material({ people: [haruto] }).relevantFor(
      "俺は窓口の椅子に座っていた。",
      4
    );

    expect(relevant.missedCharacters).toEqual([]);
  });
});

describe("落としたことを、完了の知らせへ1行で書く（設計書6.10.6）", () => {
  test("落ちた話が0なら、何も出さない", () => {
    // **毎回出る断り書きは読まれなくなる。** 起きた回にだけ言う
    expect(describeMissedCharacters([])).toBe("");
  });

  test("落ちた話の数と、作者にできることを言う", () => {
    const note = describeMissedCharacters([
      { label: "第4話", names: ["相沢 春人"] },
      { label: "第9話", names: ["相沢 春人", "如月 玲"] },
    ]);

    expect(note).toContain("2話で");
    expect(note).toContain("突き合わせていません");
    // **原稿を直せとは言わない。** 仕組みを説明して、作者に選ばせる
    expect(note).toContain("本文に名前が1度でも出れば、その回でも突き合わせます");
    // 誰を落としたかは操作ログにある
    expect(note).toContain("出力");
  });

  test("同じ話が2つのチャンクに分かれても、1話と数える", () => {
    const note = describeMissedCharacters([
      { label: "第4話", names: ["相沢 春人"] },
      { label: "第4話", names: ["相沢 春人"] },
    ]);

    expect(note).toContain("1話で");
  });
});
