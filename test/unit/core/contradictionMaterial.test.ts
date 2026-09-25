import { describe, expect, test } from "vitest";
import {
  buildContradictionTermIndex,
  carryOverBodyText,
  createContradictionMaterial,
  describeMissedCharacters,
  mergeMissedCharactersByEpisode,
  promptVersionWithAsOfChanges,
  promptVersionWithCarryOver,
  promptVersionWithNarrator,
  promptVersionWithStoryDates,
  CARRY_OVER_DEFAULT_CHAPTERS,
  CARRY_OVER_MAX_CHAPTERS,
} from "../../../src/core/contradictionMaterial";
import {
  describeCharacter,
  describeLocation,
  describeWorldItem,
} from "../../../src/core/settingsSummary";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { emptyLocation, type Location } from "../../../src/models/location";
import { emptyWorldItem, type WorldItem } from "../../../src/models/world";
import type { RecordChange } from "../../../src/models/jsonValidation";

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
  /** 語り手を名指しするときに見る（設計書6.10.6） */
  firstPerson?: string;
}): Character {
  const base = emptyCharacter(options.id, options.name);
  return {
    ...base,
    aliases: options.aliases ?? [],
    role: options.role ?? null,
    summary: options.summary ?? null,
    appearedChapters: options.chapters ?? [],
    changes: options.changes ?? [],
    firstPerson: options.firstPerson
      ? { default: options.firstPerson, variants: [] }
      : base.firstPerson,
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

  /*
    精査で再現した漏れ（2026-09-25 F1）。項目の値は巻き戻っていたが、
    変化の履歴（`changes`）を丸ごと残して `describeCharacter` へ渡していた
    ので、「変化（role）: 両腕の剣士（第1話）→ 片腕の剣士（第4話）」の行に
    **まだ起きていない変化**が載っていた。変化が1件の形では、その1件ごと
    項目が空になって人物ごと落ちるので、この漏れは見えなかった
  */
  test("先の話で起きる変化は、変化の行にも載らない（変化が2件以上）", () => {
    const akari = person({
      id: "char_001",
      name: "月島 灯",
      role: "片腕の剣士",
      chapters: [1, 2, 3, 4, 5],
      changes: [
        change("role", "両腕の剣士", [1]),
        change("role", "片腕の剣士", [4]),
      ],
    });
    const built = material({ people: [akari] });

    const atSecond = built.relevantFor("月島は剣を握った。", 2);
    expect(atSecond.characters).toContain("両腕の剣士");
    expect(atSecond.characters).not.toContain("片腕");
    expect(atSecond.characters).not.toContain("第4話");

    // 起きた話まで来れば、変化として載る
    const atFourth = built.relevantFor("月島は剣を握った。", 4);
    expect(atFourth.characters).toContain("両腕の剣士");
    expect(atFourth.characters).toContain("片腕の剣士");

    // 削った回だけ鍵に印が付く（漏れた材料で出した答えを使い回さない）
    expect(atSecond.trimmedFutureChanges).toBe(true);
    expect(atFourth.trimmedFutureChanges).toBe(false);
    expect(promptVersionWithAsOfChanges("1.7", true)).toBe("1.7:asof1");
    // 削らなかった回の鍵は、これまでと1文字も変わらない
    expect(promptVersionWithAsOfChanges("1.7", false)).toBe("1.7");
  });

  test("先の話にも続いて書かれた値は、その話までの話数だけを示す", () => {
    const akari = person({
      id: "char_001",
      name: "月島 灯",
      role: "片腕の剣士",
      chapters: [1, 2, 3],
      changes: [
        change("role", "見習いの剣士", [1]),
        change("role", "両腕の剣士", [2, 6]),
        change("role", "片腕の剣士", [7]),
      ],
    });

    const atThird = material({ people: [akari] }).relevantFor(
      "月島は剣を握った。",
      3
    );
    const changeLine = atThird.characters
      .split("\n")
      .find((line) => line.startsWith("変化（role）"));
    expect(changeLine).toContain("見習いの剣士（第1話）→ 両腕の剣士（第2話）");
    // 第6話にも同じ値で書かれていることは、第3話の時点ではまだ分からない
    expect(changeLine).not.toContain("6");
    expect(atThird.characters).not.toContain("片腕");
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

  **測ってから、0.73.3 で既定にした**（作者の裁定）。ただし既定を決めるのは
  呼ぶ側（`features` と MCP）で、**ここは渡されたものだけを見る**——引き継ぐ
  本文を渡さなければ、これまでと1文字も変わらないことをここで見張る。
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

  test("引き継ぐ本文を渡さなければ、これまでと1文字も変わらない", () => {
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

  /*
    **既定は2話ぶん**（0.73.3、作者の裁定）。作者の219話で実測した唯一の値で、
    効果（主人公が載るチャンク 80%→99%）も代償（プロンプト＋16%）も
    副作用（罠4件の台で誤検出0）も、2話ぶんで測ってある。**測っていない値を
    既定にしない**（6.102「測ってから言う」）。
  */
  test("既定は2話ぶん引き継ぐ", () => {
    expect(CARRY_OVER_DEFAULT_CHAPTERS).toBe(2);
    expect(CARRY_OVER_DEFAULT_CHAPTERS).toBeLessThanOrEqual(
      CARRY_OVER_MAX_CHAPTERS
    );
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

  **誰を「落とした」と呼ぶかは、登場話数の記録で決める**（0.73.3）。もとは
  「直前の1話に名前が出ているのに載らなかった人」だけを挙げていたが、
  引き継ぎ（`carryOver`）が既定になると**その人は必ず材料へ載る**ので、
  その手がかりだけでは二度と何も言わなくなる。**引き継ぎで塞ぎきれずに
  残った話を言う**のがこの断りの役目なので、手がかりを登場話数へ広げた。
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
    // 名前が出た主人公は落ちていない。**同じ話に居るはずの如月は落ちている**
    // ——本文にも直前の話にも名前が無いので、断りに出るのが正しい
    expect(relevant.missedCharacters).toEqual(["如月 玲"]);
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

  /*
    **登場話数の記録は、直前の話の本文より確かな手がかりである。**
    設定資料の抽出は本文を読んで「誰が出たか」を記録するので、名前が
    出ていない回の主人公も拾えている——材料の絞り込み（名前の索引）とは
    別の目で見た記録なので、**索引が落とした人をここで捕まえられる。**
  */
  test("登場話数にこの話がある人物は、直前の話を渡さなくても数える", () => {
    const relevant = material({ people: [haruto, rei] }).relevantFor(
      "俺は窓口の椅子に座っていた。",
      4
    );

    // 材料は1文字も変わらない（塞がずに、言うだけ）
    expect(relevant.characters).toBe("");
    expect(relevant.missedCharacters).toEqual(["相沢 春人", "如月 玲"]);
  });

  test("登場話数にこの話が無ければ、何も言わない", () => {
    // その話に居ない人まで並べると、40人いる作品では毎回37人が並ぶ
    const away = person({
      id: "char_004",
      name: "蓬田 吾一",
      role: "局長",
      chapters: [1, 2, 3],
    });

    expect(
      material({ people: [away] }).relevantFor("俺は窓口の椅子に座っていた。", 4)
        .missedCharacters
    ).toEqual([]);
  });

  /*
    **記録が無ければ黙る側へ倒す**（`hasAppearedBy` とは逆向きである）。
    材料へ載せるかどうかは「分からないなら落とさない」でよいが、
    断りは「分からないなら言わない」——登場話数を持たない古い資料の作品で
    全員が毎回並ぶと、この断りは読まれなくなる。
  */
  test("登場話数の記録が無い人物は、何も言わない", () => {
    const unknown = person({ id: "char_005", name: "月島 灯", role: "客" });

    expect(
      material({ people: [unknown] }).relevantFor(
        "俺は窓口の椅子に座っていた。",
        4
      ).missedCharacters
    ).toEqual([]);
  });

  test("話数の読めないチャンクでは、何も言わない", () => {
    // どの話の一部かを決められないので、「この話に居るはず」も決められない
    expect(
      material({ people: [haruto] }).relevantFor(
        "俺は窓口の椅子に座っていた。",
        null
      ).missedCharacters
    ).toEqual([]);
  });

  /*
    **引き継ぎで塞いだ回では、やはり黙る。** 「穴を塞いだ」と「落としたと
    言う」が二重に出ないことを、登場話数の側でも見張る。
  */
  test("引き継ぎで載った人物は、登場話数にあっても言わない", () => {
    const relevant = material({ people: [haruto] }).relevantFor(
      "俺は窓口の椅子に座っていた。",
      4,
      { carryOverText: "相沢は坂を下りた。" }
    );

    expect(relevant.characters).toBe(describeCharacter(haruto, []));
    expect(relevant.missedCharacters).toEqual([]);
  });

  test("直前の話を渡さず、登場話数にも無ければ、何も言わない", () => {
    const other = person({
      id: "char_006",
      name: "黒瀬 澪",
      role: "転校生",
      chapters: [1, 2],
    });

    expect(
      material({ people: [other] }).relevantFor("俺は窓口の椅子に座っていた。", 4)
        .missedCharacters
    ).toEqual([]);
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

/*
  **判定はチャンク単位、断りは話単位**（設計書6.10.6）。

  1話がチャンクの上限を超えて2つに割れ、人物が後半にだけ登場していると、
  前半のチャンクではその人物が落ちる。そのまま並べると、**実際には
  突き合わせているのに「突き合わせていません」と言う**（0.70.12で直した）。
*/
describe("チャンクごとの結果を、話ごとにまとめる（設計書6.10.6）", () => {
  test("1つのチャンクにでも載っていれば、その話は断りに出さない", () => {
    const merged = mergeMissedCharactersByEpisode([
      // 第11話の前半：本文にXが無いので落ちた
      { label: "第11話", chapter: 11, names: ["黒瀬 澪"] },
      // 第11話の後半：本文にXがあるので落ちていない
      { label: "第11話", chapter: 11, names: [] },
    ]);

    expect(merged).toEqual([]);
  });

  test("すべてのチャンクで落ちている人物だけを挙げる", () => {
    const merged = mergeMissedCharactersByEpisode([
      { label: "第11話", chapter: 11, names: ["黒瀬 澪", "相沢 春人"] },
      { label: "第11話", chapter: 11, names: ["相沢 春人"] },
    ]);

    expect(merged).toEqual([{ label: "第11話", names: ["相沢 春人"] }]);
  });

  test("割れていない話は、これまでどおりそのまま出す", () => {
    const merged = mergeMissedCharactersByEpisode([
      { label: "第4話", chapter: 4, names: ["相沢 春人"] },
      { label: "第5話", chapter: 5, names: [] },
      { label: "第9話", chapter: 9, names: ["如月 玲"] },
    ]);

    expect(merged).toEqual([
      { label: "第4話", names: ["相沢 春人"] },
      { label: "第9話", names: ["如月 玲"] },
    ]);
  });

  test("合本でも、話が違えばまとめない（札は同じでも別の話）", () => {
    // **まとめる単位は話数であって札ではない。** 合本は札がファイル単位で
    // 決まるので、札でまとめると作品まるごとの積になり、断りが消える
    const merged = mergeMissedCharactersByEpisode([
      { label: "第1〜19話", chapter: 4, names: ["相沢 春人"] },
      { label: "第1〜19話", chapter: 5, names: ["如月 玲"] },
    ]);

    expect(merged).toEqual([
      { label: "第1〜19話", names: ["相沢 春人"] },
      { label: "第1〜19話", names: ["如月 玲"] },
    ]);
  });

  test("話数の読めないチャンクは、ひとまとめにしない", () => {
    // 前後を決められないものに「同じ話」は無い。積を取ると、
    // 関係のないチャンクどうしで打ち消し合う
    const merged = mergeMissedCharactersByEpisode([
      { label: "1番目のまとまり", chapter: null, names: ["相沢 春人"] },
      { label: "2番目のまとまり", chapter: null, names: [] },
    ]);

    expect(merged).toEqual([{ label: "1番目のまとまり", names: ["相沢 春人"] }]);
  });

  test("材料の組み立てと繋いでも、割れた話は断りに出ない", () => {
    // **本番と同じ口（`relevantFor`）を通して確かめる。** 期待値だけを
    // 手で置くと、材料の側が変わったときに気づけない
    const rei = person({
      id: "char_002",
      name: "如月 玲",
      role: "担任教師",
      chapters: [1, 2, 3, 4, 11],
    });
    const settings = material({ people: [rei] });
    const previous = "如月は職員室にいた。";
    // 1話が2つのチャンクに割れ、名前は後半にだけ出る
    const halves = ["俺は窓口の椅子に座っていた。", "如月が扉を開けた。"];

    const merged = mergeMissedCharactersByEpisode(
      halves.map((text) => ({
        label: "第11話",
        chapter: 11,
        names: settings.relevantFor(text, 11, { previousBodyText: previous })
          .missedCharacters,
      }))
    );

    // 前半だけを見れば落ちている（＝直す前は誤警報が出ていた）
    expect(
      settings.relevantFor(halves[0], 11, { previousBodyText: previous })
        .missedCharacters
    ).toEqual(["如月 玲"]);
    expect(merged).toEqual([]);
  });
});

/*
  **地の文の「俺」が誰かを名指しする**（設計書6.10.6）。

  材料に載せるところまでは引き継ぎで済んでいる（80%→99%）が、地の文は
  「俺」、設定は「相沢 春人」なので、**同じ人物だとAIが確信しきれない**
  ——答え付きの台での当たりは 2/4 のまま増えなかった。

  **決め打ちはしない。** 一人称が一致する人物が材料の中に**ちょうど1人**
  いるときだけ名指しし、絞れなければ黙る。
*/
describe("この話の語り手（設計書6.10.6）", () => {
  const haruto = person({
    id: "char_001",
    name: "相沢 春人",
    role: "生活支援課の職員",
    firstPerson: "俺",
    chapters: [1, 2, 3, 4, 5],
  });
  const chinatsu = person({
    id: "char_002",
    name: "黒瀬 千夏",
    role: "窓口の相談員",
    firstPerson: "私",
    chapters: [1, 2, 3, 4, 5],
  });

  /**
   * 名前の出ない地の文（一人称小説の本文）。
   *
   * **`detectFirstPerson` は台詞を落として500字以上／10回以上でなければ
   * 決めない**ので、見本も同じ長さが要る。
   */
  function narration(word: string, times = 14): string {
    return Array.from(
      { length: times },
      (_, index) =>
        `${word}は窓口の椅子に座っていた。冷えた蛍光灯の下で、書類の角が` +
        `わずかに反り返っている。外は雨だった。${index}`
    ).join("\n");
  }

  /** 前の話の本文。**人物を索引で見つけるためだけ**に渡す（材料には入らない） */
  const carryOverText = "相沢は坂を下りた。黒瀬は窓口で待っていた。";

  test("一人称が一致する人物が材料に1人だけなら、名指しする", () => {
    const relevant = material({ people: [haruto, chinatsu] }).relevantFor(
      narration("俺"),
      4,
      { carryOverText }
    );

    expect(relevant.narrator).toEqual({ firstPerson: "俺", name: "相沢 春人" });
  });

  test("引き継いだ本文と繋いで一人称を数える（対象だけでは短い回がある）", () => {
    // 1話ぶんの地の文が短いと、対象チャンクだけでは決められない。
    // 引き継ぎ（既定2話）を混ぜて数えれば届く
    const settings = material({ people: [haruto, chinatsu] });
    const short = "俺は窓口の椅子に座っていた。相沢は黒瀬を見た。";

    expect(settings.relevantFor(short, 4, {}).narrator).toBeNull();
    expect(
      settings.relevantFor(short, 4, {
        carryOverText: narration("俺"),
      }).narrator
    ).toEqual({ firstPerson: "俺", name: "相沢 春人" });
  });

  test("材料に載っていない人物は、語り手と呼ばない", () => {
    // 引き継ぎでも名前が出ず、材料に載らなかった人物を名指しすると、
    // 「照らし合わせる相手がある」と言いながら設定を渡していないことになる
    const relevant = material({ people: [haruto, chinatsu] }).relevantFor(
      narration("俺"),
      4,
      { carryOverText: "黒瀬は窓口で待っていた。" }
    );

    expect(relevant.characters).toBe(describeCharacter(chinatsu, []));
    expect(relevant.narrator).toBeNull();
  });

  test("同じ一人称の人物が2人載っていたら黙る", () => {
    const goichi = person({
      id: "char_003",
      name: "蓬田 吾一",
      role: "常連の相談者",
      firstPerson: "俺",
      chapters: [1, 2, 3, 4, 5],
    });

    expect(
      material({ people: [haruto, goichi] }).relevantFor(narration("俺"), 4, {
        carryOverText: "相沢は坂を下りた。蓬田は窓口に来た。",
      }).narrator
    ).toBeNull();
  });

  test("三人称の本文では黙る", () => {
    expect(
      material({ people: [haruto, chinatsu] }).relevantFor(
        narration("春人"),
        4,
        { carryOverText }
      ).narrator
    ).toBeNull();
  });

  test("話数で材料から外れた人物は、語り手にもならない（6.10.3）", () => {
    // その話の時点でまだ登場していない人物は材料に載らない。
    // 載っていないものを名指ししない
    const later = person({
      id: "char_004",
      name: "相沢 春人",
      role: "生活支援課の職員",
      firstPerson: "俺",
      chapters: [9],
    });

    const relevant = material({ people: [later] }).relevantFor(
      narration("俺"),
      4,
      { carryOverText: "相沢は坂を下りた。" }
    );

    expect(relevant.characters).toBe("");
    expect(relevant.narrator).toBeNull();
  });

  /*
    **語り手の欄は、材料の選び方を1文字も変えない。**

    プロンプトが変わるとキャッシュの鍵に**別の材料で得た答え**が入るので、
    ここは「数えるだけ」の欄でなければならない（`missedCharacters` と同じ）。
  */
  test("characters・hasAnything・missedCharacters はこれまでと同じ", () => {
    const relevant = material({ people: [haruto, chinatsu] }).relevantFor(
      narration("俺"),
      4,
      { carryOverText, previousBodyText: "相沢は坂を下りた。" }
    );

    expect(relevant.characters).toBe(
      [describeCharacter(haruto, []), describeCharacter(chinatsu, [])].join(
        "\n\n"
      )
    );
    expect(relevant.hasAnything).toBe(true);
    expect(relevant.missedCharacters).toEqual([]);
    expect(relevant.locations).toBe("");
  });

  test("語り手が決まらなくても、材料はこれまでどおり載る", () => {
    // 名指しできない作品でも、突き合わせそのものは従来と同じに動く
    const relevant = material({ people: [chinatsu] }).relevantFor(
      narration("俺"),
      4,
      { carryOverText: "黒瀬は窓口で待っていた。" }
    );

    expect(relevant.narrator).toBeNull();
    expect(relevant.characters).toBe(describeCharacter(chinatsu, []));
    expect(relevant.hasAnything).toBe(true);
  });
});

describe("語り手をキャッシュの鍵へ混ぜる（設計書6.10.6）", () => {
  test("名指しできなければ、版はそのまま（処理済みが飛ばない）", () => {
    // **語り手の欄が出ない作品では、送る内容も鍵もこれまでと同じ**である。
    // 版（1.6）を上げなかったのはこのため
    expect(promptVersionWithNarrator("1.6", null)).toBe("1.6");
  });

  test("名指しした回だけ、版に印が付く", () => {
    const key = promptVersionWithNarrator("1.6", {
      firstPerson: "俺",
      name: "相沢 春人",
    });

    expect(key).not.toBe("1.6");
    expect(key.startsWith("1.6:narrator")).toBe(true);
  });

  test("名指しした相手が変われば、鍵も変わる", () => {
    // 台帳の一人称が直れば、名指しする相手も変わりうる
    const first = promptVersionWithNarrator("1.6", {
      firstPerson: "俺",
      name: "相沢 春人",
    });
    const second = promptVersionWithNarrator("1.6", {
      firstPerson: "俺",
      name: "蓬田 吾一",
    });

    expect(first).not.toBe(second);
  });

  test("同じ語り手なら、いつでも同じ鍵になる", () => {
    const narrator = { firstPerson: "俺", name: "相沢 春人" };

    expect(promptVersionWithNarrator("1.6", narrator)).toBe(
      promptVersionWithNarrator("1.6", { ...narrator })
    );
  });
});

describe("作中の日付をキャッシュの鍵へ混ぜる（設計書6.10.9）", () => {
  const section = "【作中の日付】\n第2話: 十月三日\nこの話（第5話）: 十二月八日（第2話から66日）";

  test("読み取れなければ、版はそのまま（処理済みが飛ばない）", () => {
    // **日付の欄が出ない作品では、送る内容も鍵もこれまでと同じ**である。
    // 版（1.6）を上げなかったのはこのため
    expect(promptVersionWithStoryDates("1.6", "")).toBe("1.6");
  });

  test("欄を出した回だけ、版に印が付く", () => {
    const key = promptVersionWithStoryDates("1.6", section);

    expect(key).not.toBe("1.6");
    expect(key.startsWith("1.6:dates")).toBe(true);
  });

  test("並んだ日付が変われば、鍵も変わる", () => {
    // あらすじを書き直せば読み取れる日付も変わるし、話が進めば行も増える
    expect(promptVersionWithStoryDates("1.6", section)).not.toBe(
      promptVersionWithStoryDates("1.6", `${section}\nこの話（第6話）: 一月四日`)
    );
  });

  test("同じ欄なら、いつでも同じ鍵になる", () => {
    expect(promptVersionWithStoryDates("1.6", section)).toBe(
      promptVersionWithStoryDates("1.6", `${section}`)
    );
  });

  test("語り手の印と重ねても、どちらも消えない", () => {
    // 抜粋・引き継ぎ・語り手・日付は同じ版へ順に積む
    const key = promptVersionWithStoryDates(
      promptVersionWithNarrator("1.6", {
        firstPerson: "俺",
        name: "相沢 春人",
      }),
      section
    );

    expect(key).toContain(":narrator");
    expect(key).toContain(":dates");
  });
});
