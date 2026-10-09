import { describe, expect, it } from "vitest";
import {
  emptyLocation,
  type Location,
  type LocationRelation,
} from "../../../src/models/location";
import {
  DIRECTION_TOLERANCE_STEPS,
  DISTANCE_RATIO_THRESHOLD,
  findLocationInconsistencies,
  normalizeDirection,
  normalizeTravel,
  placeLocationInconsistencies,
  recordIssueOf,
  type EpisodeText,
} from "../../../src/core/locationConsistency";

/**
 * 場所の位置関係の機械照合（設計書6.93.4。順2）。
 *
 * **当たりと誤検出の両方を見る。** 何も出さない実装が満点にならないよう、
 * 矛盾を仕込んだ組（循環・方角の非対称・距離の食い違い）と、
 * 矛盾ではない組（隣り合う方位・往復で整合する方角・乗り物の違う距離・
 * 隣接なのに遠い・自由文の方角）を並べる。
 */

function rel(
  kind: LocationRelation["kind"],
  target: string,
  value: string | null = null,
  extra: Partial<LocationRelation> = {}
): LocationRelation {
  return {
    kind,
    target,
    targetId: null,
    value,
    chapters: [],
    evidence: null,
    authorLocked: false,
    ...extra,
  };
}

function place(
  id: string,
  name: string,
  relations: LocationRelation[] = [],
  extra: Partial<Location> = {}
): Location {
  return { ...emptyLocation(id, name), relations, ...extra };
}

describe("正規化——比べられる形だけを比べる", () => {
  it("8方位と、その言い換えを読む", () => {
    expect(normalizeDirection("北")).toBe(0);
    expect(normalizeDirection("北東")).toBe(1);
    expect(normalizeDirection("東北")).toBe(1);
    expect(normalizeDirection("南側")).toBe(4);
    expect(normalizeDirection("真西")).toBe(6);
  });

  it("自由文の方角（上流・山側）は読まない", () => {
    expect(normalizeDirection("上流")).toBeNull();
    expect(normalizeDirection("山側")).toBeNull();
    expect(normalizeDirection("北のほうの丘の上")).toBeNull();
  });

  it("徒歩N分・N時間・半日・N日を分に直し、乗り物を分ける", () => {
    expect(normalizeTravel("徒歩10分")).toEqual({ mode: "徒歩", minutes: 10 });
    expect(normalizeTravel("歩いて十分ほど")).toEqual({ mode: "徒歩", minutes: 10 });
    expect(normalizeTravel("徒歩１時間")).toEqual({ mode: "徒歩", minutes: 60 });
    expect(normalizeTravel("馬で半日")).toEqual({ mode: "馬", minutes: 720 });
    expect(normalizeTravel("三日の距離")).toEqual({ mode: "", minutes: 4320 });
    expect(normalizeTravel("車で1時間半")).toEqual({ mode: "車", minutes: 90 });
    expect(normalizeTravel("馬車で二十日")).toEqual({ mode: "馬車", minutes: 28800 });
  });

  it("正規化できない言い方は比べない（推測で数にしない）", () => {
    expect(normalizeTravel("すぐそこ")).toBeNull();
    expect(normalizeTravel("数日")).toBeNull();
    expect(normalizeTravel("飛竜で一日")).toBeNull();
    expect(normalizeTravel("石を投げれば届く")).toBeNull();
  });
});

describe("含む関係の循環", () => {
  it("2か所で互いに中にある", () => {
    const found = findLocationInconsistencies([
      place("loc_001", "港町", [rel("within", "港")]),
      place("loc_002", "港", [rel("within", "港町")]),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("cycle");
    expect(found[0].statements.map((s) => s.text).sort()).toEqual([
      "港は港町の中",
      "港町は港の中",
    ]);
  });

  it("3か所で輪になる（1件にまとめる）", () => {
    const found = findLocationInconsistencies([
      place("loc_001", "王都", [rel("within", "城")]),
      place("loc_002", "城", [rel("within", "中庭")]),
      place("loc_003", "中庭", [rel("within", "王都")]),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("cycle");
    expect(found[0].statements).toHaveLength(3);
  });

  it("地域の欄も、台帳に同じ名前の場所があれば「中」として読む", () => {
    const found = findLocationInconsistencies([
      place("loc_001", "港町", [rel("within", "港")]),
      place("loc_002", "港", [], { region: "港町" }),
    ]);
    expect(found).toHaveLength(1);
    const fromRegion = found[0].statements.find((s) => s.fromRegion);
    expect(fromRegion?.text).toBe("港は港町の中（地域の欄）");
  });

  it("片方向の中・入れ子の連なりは矛盾にしない", () => {
    expect(
      findLocationInconsistencies([
        place("loc_001", "王都", []),
        place("loc_002", "城", [rel("within", "王都")]),
        place("loc_003", "中庭", [rel("within", "城")]),
      ])
    ).toEqual([]);
  });

  it("地域の欄が台帳に無い名前なら、関係として読まない", () => {
    expect(
      findLocationInconsistencies([
        place("loc_001", "港", [rel("within", "港町")], { region: "港町" }),
      ])
    ).toEqual([]);
  });

  it("別名で書かれた相手も同じ場所として辿る", () => {
    const found = findLocationInconsistencies([
      place("loc_001", "港町", [rel("within", "港")], { aliases: ["ミナト町"] }),
      place("loc_002", "港", [rel("within", "ミナト町")]),
    ]);
    expect(found.map((f) => f.kind)).toEqual(["cycle"]);
  });
});

describe("方角の非対称", () => {
  it("学校は港の北、港は学校の北——矛盾", () => {
    const found = findLocationInconsistencies([
      place("loc_001", "学校", [rel("direction", "港", "北")]),
      place("loc_002", "港", [rel("direction", "学校", "北")]),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("direction");
    expect(found[0].statements.map((s) => s.text).sort()).toEqual([
      "学校は港の北",
      "港は学校の北",
    ]);
  });

  it("学校は港の北、港は学校の南——整合（矛盾にしない）", () => {
    expect(
      findLocationInconsistencies([
        place("loc_001", "学校", [rel("direction", "港", "北")]),
        place("loc_002", "港", [rel("direction", "学校", "南")]),
      ])
    ).toEqual([]);
  });

  it("隣り合う方位（東と北東）は許す——境目を固定する", () => {
    expect(DIRECTION_TOLERANCE_STEPS).toBe(1);
    // 学校は港の東 ⇔ 港は学校の西。港は学校の南西＝学校は港の北東（45°ずれ）
    expect(
      findLocationInconsistencies([
        place("loc_001", "学校", [rel("direction", "港", "東")]),
        place("loc_002", "港", [rel("direction", "学校", "南西")]),
      ])
    ).toEqual([]);
    // 90°ずれ（港は学校の南＝学校は港の北 と、学校は港の東）は矛盾
    const found = findLocationInconsistencies([
      place("loc_001", "学校", [rel("direction", "港", "東")]),
      place("loc_002", "港", [rel("direction", "学校", "南")]),
    ]);
    expect(found.map((f) => f.kind)).toEqual(["direction"]);
  });

  it("自由文の方角（上流）は比べない", () => {
    expect(
      findLocationInconsistencies([
        place("loc_001", "村", [rel("direction", "橋", "上流")]),
        place("loc_002", "橋", [rel("direction", "村", "上流")]),
      ])
    ).toEqual([]);
  });

  it("台帳に無い相手との関係は、相手側の記録が無いので比べない", () => {
    expect(
      findLocationInconsistencies([
        place("loc_001", "学校", [rel("direction", "灯台", "北")]),
      ])
    ).toEqual([]);
  });
});

describe("距離の食い違い", () => {
  it("港から学校は徒歩10分／学校から港は徒歩1時間——矛盾", () => {
    const found = findLocationInconsistencies([
      place("loc_001", "学校", [rel("distance", "港", "徒歩10分")]),
      place("loc_002", "港", [rel("distance", "学校", "徒歩1時間")]),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("distance");
    expect(found[0].summary).toContain("徒歩10分");
    expect(found[0].summary).toContain("徒歩1時間");
  });

  it("近い値（徒歩10分と15分）は矛盾にしない——倍率の境目を固定する", () => {
    expect(DISTANCE_RATIO_THRESHOLD).toBe(5);
    expect(
      findLocationInconsistencies([
        place("loc_001", "学校", [rel("distance", "港", "徒歩10分")]),
        place("loc_002", "港", [rel("distance", "学校", "徒歩15分")]),
      ])
    ).toEqual([]);
    // 4倍は許し、5倍で挙げる
    expect(
      findLocationInconsistencies([
        place("loc_001", "学校", [rel("distance", "港", "徒歩10分")]),
        place("loc_002", "港", [rel("distance", "学校", "徒歩40分")]),
      ])
    ).toEqual([]);
    expect(
      findLocationInconsistencies([
        place("loc_001", "学校", [rel("distance", "港", "徒歩10分")]),
        place("loc_002", "港", [rel("distance", "学校", "徒歩50分")]),
      ])
    ).toHaveLength(1);
  });

  it("乗り物が違えば比べない（徒歩と馬）", () => {
    expect(
      findLocationInconsistencies([
        place("loc_001", "村", [rel("distance", "王都", "徒歩三日")]),
        place("loc_002", "王都", [rel("distance", "村", "馬で半日")]),
      ])
    ).toEqual([]);
  });

  it("乗り物の書いていない距離と徒歩も比べない", () => {
    expect(
      findLocationInconsistencies([
        place("loc_001", "村", [rel("distance", "王都", "三日の距離")]),
        place("loc_002", "王都", [rel("distance", "村", "徒歩10分")]),
      ])
    ).toEqual([]);
  });

  it("隣接なのに遠い、は挙げない（隣接の粒度は作品で違う）", () => {
    expect(
      findLocationInconsistencies([
        place("loc_001", "村", [
          rel("adjacent", "森"),
          rel("distance", "森", "馬で半日"),
        ]),
        place("loc_002", "森", [rel("adjacent", "村")]),
      ])
    ).toEqual([]);
  });
});

describe("矛盾の無い台帳", () => {
  it("含む・方角・距離・隣接が揃って整合していれば何も出さない", () => {
    expect(
      findLocationInconsistencies([
        place("loc_001", "港町"),
        place("loc_002", "港", [rel("within", "港町")]),
        place("loc_003", "学校", [
          rel("within", "港町"),
          rel("direction", "港", "北"),
          rel("distance", "港", "徒歩10分"),
        ]),
        place("loc_004", "防波堤", [rel("adjacent", "港")]),
        place("loc_005", "灯台", [rel("direction", "港", "東")], {
          region: "港町",
        }),
      ])
    ).toEqual([]);
  });
});

describe("本文の行へ置く", () => {
  const episodes: EpisodeText[] = [
    {
      filePath: "/w/本文/003_三.txt",
      chapterStart: 3,
      chapterEnd: 3,
      text: "　朝。\n　学校は港の北の高台にある。\n　坂を上った。",
    },
    {
      filePath: "/w/本文/007_七.txt",
      chapterStart: 7,
      chapterEnd: 7,
      text: "　夕方。\n\n　港は学校の北に見えた。\n",
    },
  ];
  const locations = [
    place("loc_001", "学校", [
      rel("direction", "港", "北", {
        chapters: [3],
        evidence: "学校は港の北の高台にある",
      }),
    ]),
    place("loc_002", "港", [
      rel("direction", "学校", "北", {
        chapters: [7],
        evidence: "「港は学校の北に見えた。」",
      }),
    ]),
  ];

  it("あとの話の引用を飛び先にし、先の話の引用を並べる", () => {
    const found = findLocationInconsistencies(locations);
    const placed = placeLocationInconsistencies(found, episodes);
    expect(placed.unplaced).toEqual([]);
    expect(placed.issues).toHaveLength(1);
    const issue = placed.issues[0];
    expect(issue.filePath).toBe("/w/本文/007_七.txt");
    expect(issue.line).toBe(3);
    expect(issue.excerpt).toBe("港は学校の北に見えた");
    expect(issue.category).toBe("場所");
    expect(issue.confidence).toBe("high");
    expect(issue.textSays).toContain("第7話");
    expect(issue.settingSays).toContain("第3話");
    expect(issue.settingSays).toContain("学校は港の北の高台にある");
    // 修正案（本文の書き換え）は持たない
    expect(issue).not.toHaveProperty("suggestion");
  });

  it("範囲で絞ったときは、範囲の中の引用を飛び先に選び、範囲に触れないものは出さない", () => {
    const found = findLocationInconsistencies(locations);
    const inScope = placeLocationInconsistencies(found, episodes, {
      scopeFiles: new Set(["/w/本文/003_三.txt"]),
    });
    expect(inScope.issues.map((i) => i.filePath)).toEqual(["/w/本文/003_三.txt"]);
    expect(inScope.issues[0].line).toBe(2);

    const outOfScope = placeLocationInconsistencies(found, episodes, {
      scopeFiles: new Set(["/w/本文/010_十.txt"]),
    });
    expect(outOfScope.issues).toEqual([]);
  });

  it("根拠も話数も無い（作者が書いた関係どうし）ものは、行に置けないものとして返す", () => {
    const found = findLocationInconsistencies([
      place("loc_001", "学校", [rel("direction", "港", "北")]),
      place("loc_002", "港", [rel("direction", "学校", "北")]),
    ]);
    const placed = placeLocationInconsistencies(found, episodes);
    expect(placed.issues).toEqual([]);
    expect(placed.unplaced).toHaveLength(1);
  });

  it("引用が本文から消えていても、話数が分かればその話の頭へ置く", () => {
    const found = findLocationInconsistencies([
      place("loc_001", "学校", [
        rel("direction", "港", "北", { chapters: [3], evidence: "書き直されて消えた一文" }),
      ]),
      place("loc_002", "港", [rel("direction", "学校", "北")]),
    ]);
    const placed = placeLocationInconsistencies(found, episodes);
    expect(placed.issues).toHaveLength(1);
    expect(placed.issues[0].filePath).toBe("/w/本文/003_三.txt");
    expect(placed.issues[0].line).toBe(1);
  });
});

describe("本文に置けない食い違いを、場所の資料を開く1件にする（設計書6.93.9 の順6）", () => {
  it("作者が書いた関係どうしの距離の食い違いは、先頭の記述を持つ場所の資料を指す", () => {
    const locations = [
      place("loc_001", "港", [rel("distance", "学校", "徒歩2時間")]),
      place("loc_002", "学校", [rel("distance", "港", "徒歩10分")]),
    ];
    const placed = placeLocationInconsistencies(findLocationInconsistencies(locations), []);
    expect(placed.issues).toEqual([]);
    expect(placed.unplaced).toHaveLength(1);

    const issue = recordIssueOf(placed.unplaced[0], (id) => `設定/locations/${id}.json`);
    expect(issue).toMatchObject({
      kind: "distance",
      locationId: "loc_001",
      locationName: "港",
      filePath: "設定/locations/loc_001.json",
      textSays: "港は学校から徒歩2時間（作者が書いた関係）",
      settingSays: "学校は港から徒歩10分（作者が書いた関係）",
    });
    expect(issue.summary).toContain("距離が食い違っています");
  });
});
