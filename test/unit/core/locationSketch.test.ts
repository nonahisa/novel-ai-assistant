import { describe, expect, it } from "vitest";
import {
  emptyLocation,
  type Location,
  type LocationRelation,
} from "../../../src/models/location";
import {
  buildLocationSketch,
  SKETCH_MAX_LENGTH,
  TRAVEL_SPEEDS_KMH,
  type LocationSketch,
  type SketchPoint,
} from "../../../src/core/locationSketch";

/**
 * 場所の略図の置き方（設計書6.93.10。作者の裁定 2026-10-09 夜）。
 *
 * **当たりと「決めたふりをしない」側の両方を見る。** 方角と距離が両方そろった
 * 位置は決まった位置として置き、片方しか無いものは仮に置いたと分かる形
 * （点線・「距離未定」「向き未定」）で置く。手がかりの無い場所は図に置かず、
 * 位置未定の棚へ並べる。
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

function pointOf(sketch: LocationSketch, name: string): SketchPoint {
  const found = sketch.points.find((point) => point.name === name);
  if (!found) throw new Error(`${name} が図にありません`);
  return found;
}

function lineBetween(sketch: LocationSketch, a: string, b: string) {
  const ids = [pointOf(sketch, a).id, pointOf(sketch, b).id];
  const found = sketch.lines.find(
    (line) => ids.includes(line.from) && ids.includes(line.to)
  );
  if (!found) throw new Error(`${a}と${b}の線がありません`);
  return found;
}

function distance(a: SketchPoint, b: SketchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 港を真ん中に、北に学校（徒歩10分）、東に灯台（徒歩20分） */
function harbor(): Location[] {
  return [
    place("loc_001", "港"),
    place("loc_002", "学校", [rel("direction", "港", "北"), rel("distance", "港", "徒歩10分")]),
    place("loc_003", "灯台", [rel("direction", "港", "東"), rel("distance", "港", "徒歩20分")]),
  ];
}

describe("方角と距離がそろった位置は決まる", () => {
  it("北は上、東は右に、距離に比例して置く", () => {
    const sketch = buildLocationSketch(harbor());
    const port = pointOf(sketch, "港");
    const school = pointOf(sketch, "学校");
    const lighthouse = pointOf(sketch, "灯台");

    expect(school.y).toBeLessThan(port.y);
    expect(Math.abs(school.x - port.x)).toBeLessThan(0.5);
    expect(lighthouse.x).toBeGreaterThan(port.x);
    expect(Math.abs(lighthouse.y - port.y)).toBeLessThan(0.5);
    // 徒歩20分は徒歩10分の2倍の長さ
    expect(distance(port, lighthouse) / distance(port, school)).toBeCloseTo(2, 5);
  });

  it("決まった位置は実線で、線に「北・徒歩10分」と書く", () => {
    const sketch = buildLocationSketch(harbor());
    const line = lineBetween(sketch, "港", "学校");
    expect(line).toMatchObject({ dashed: false, label: "北・徒歩10分" });
    expect(pointOf(sketch, "学校").settled).toBe(true);
    expect(pointOf(sketch, "港").placement).toBe("origin");
  });

  it("関係を相手の側に書いても（港は学校の南）、同じ向きに置く", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "港", [rel("direction", "学校", "南"), rel("distance", "学校", "徒歩10分")]),
      place("loc_002", "学校"),
    ]);
    expect(pointOf(sketch, "学校").y).toBeLessThan(pointOf(sketch, "港").y);
  });

  it("同じ入力なら、同じ図になる（画面の座標と保存した位置がずれない）", () => {
    expect(buildLocationSketch(harbor())).toEqual(buildLocationSketch(harbor()));
  });

  it("渡した場所の記録を書き換えない", () => {
    const locations = harbor();
    const before = JSON.stringify(locations);
    buildLocationSketch(locations);
    expect(JSON.stringify(locations)).toBe(before);
  });
});

describe("決まらない位置を、決めたふりで描かない", () => {
  it("方角だけの関係は実線で描かず、「距離未定」と書いて仮に置く", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "港"),
      place("loc_002", "学校", [rel("direction", "港", "北")]),
    ]);
    const line = lineBetween(sketch, "港", "学校");
    expect(line.dashed).toBe(true);
    expect(line.label).toBe("北・距離未定");
    expect(pointOf(sketch, "学校").settled).toBe(false);
    expect(pointOf(sketch, "学校").placement).toBe("directionOnly");
    // 向きは決まっているので、北へ置く
    expect(pointOf(sketch, "学校").y).toBeLessThan(pointOf(sketch, "港").y);
  });

  it("距離だけの関係は「向き未定」と書いて仮に置く", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "港"),
      place("loc_002", "学校", [rel("distance", "港", "徒歩10分")]),
    ]);
    const line = lineBetween(sketch, "港", "学校");
    expect(line.dashed).toBe(true);
    expect(line.label).toBe("徒歩10分・向き未定");
    expect(pointOf(sketch, "学校").settled).toBe(false);
    expect(pointOf(sketch, "学校").placement).toBe("distanceOnly");
  });

  it("決まらない点から先へ置いた点も、決まった位置とは言わない", () => {
    const sketch = buildLocationSketch([
      // 港が起点になるよう、港にも決まった関係を1つ持たせる（関係の数が学校と並ぶ）
      place("loc_001", "港"),
      place("loc_002", "学校", [rel("direction", "港", "北")]),
      place("loc_003", "図書館", [rel("direction", "学校", "東"), rel("distance", "学校", "徒歩5分")]),
      place("loc_004", "灯台", [rel("direction", "港", "東"), rel("distance", "港", "徒歩20分")]),
    ]);
    expect(pointOf(sketch, "港").placement).toBe("origin");
    expect(pointOf(sketch, "図書館").settled).toBe(false);
    // 線そのものは方角と距離がそろっているので実線
    expect(lineBetween(sketch, "学校", "図書館").dashed).toBe(false);
  });

  it("手がかりの無い場所は図に置かず、位置未定の棚に並べる", () => {
    const sketch = buildLocationSketch([...harbor(), place("loc_004", "王城")]);
    expect(sketch.points.map((point) => point.name)).not.toContain("王城");
    expect(sketch.shelf.map((entry) => entry.name)).toEqual(["王城"]);
  });

  it("読めない方角（上流）と台帳に無い相手は線にせず、使えなかった関係として挙げる", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "港"),
      place("loc_002", "水車小屋", [rel("direction", "港", "上流")]),
      place("loc_003", "砦", [rel("direction", "名もなき峠", "北"), rel("distance", "名もなき峠", "徒歩1時間")]),
    ]);
    expect(sketch.lines).toEqual([]);
    expect(sketch.shelf.map((entry) => entry.name)).toEqual(["港", "水車小屋", "砦"]);
    expect(sketch.unused.map((entry) => entry.text)).toEqual([
      "水車小屋は港の上流",
      "砦は名もなき峠の北",
      "砦は名もなき峠から徒歩1時間",
    ]);
    expect(sketch.unused[0].reason).toContain("方角");
    expect(sketch.unused[1].reason).toContain("台帳");
  });

  it("隣接は短い線「隣接」で寄せるだけ（位置は決まらない）", () => {
    const sketch = buildLocationSketch([
      ...harbor(),
      place("loc_004", "防波堤", [rel("adjacent", "港")]),
    ]);
    const line = lineBetween(sketch, "港", "防波堤");
    expect(line.kind).toBe("adjacent");
    expect(line.label).toBe("隣接");
    expect(pointOf(sketch, "防波堤").settled).toBe(false);
    expect(distance(pointOf(sketch, "港"), pointOf(sketch, "防波堤"))).toBeLessThan(
      distance(pointOf(sketch, "港"), pointOf(sketch, "学校"))
    );
  });
});

describe("含む関係は枠の入れ子", () => {
  it("中にある場所を親の枠で囲み、入れ子は深さで分ける", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "王国"),
      place("loc_002", "港町", [rel("within", "王国")]),
      place("loc_003", "港", [rel("within", "港町")]),
    ]);
    const kingdom = sketch.frames.find((frame) => frame.name === "王国");
    const town = sketch.frames.find((frame) => frame.name === "港町");
    expect(kingdom).toBeDefined();
    expect(town).toBeDefined();
    const port = pointOf(sketch, "港");
    for (const frame of [kingdom!, town!]) {
      expect(port.x).toBeGreaterThan(frame.x);
      expect(port.x).toBeLessThan(frame.x + frame.width);
      expect(port.y).toBeGreaterThan(frame.y);
      expect(port.y).toBeLessThan(frame.y + frame.height);
    }
    // 港町の枠は王国の枠の内側
    expect(town!.x).toBeGreaterThan(kingdom!.x);
    expect(town!.x + town!.width).toBeLessThan(kingdom!.x + kingdom!.width);
    expect(town!.depth).toBeGreaterThan(kingdom!.depth);
    // 含む関係は線にしない（枠で表す）
    expect(sketch.lines).toEqual([]);
  });

  it("地域の欄も、台帳に同じ名前の場所があれば中として読む", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "王都"),
      place("loc_002", "大聖堂", [], { region: "王都" }),
    ]);
    expect(sketch.frames.map((frame) => frame.name)).toEqual(["王都"]);
  });

  it("含む関係が輪になっていたら枠を描かない（食い違いとして挙げる）", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "港町", [rel("within", "港")]),
      place("loc_002", "港", [rel("within", "港町")]),
    ]);
    expect(sketch.frames).toEqual([]);
    expect(sketch.conflicts.map((conflict) => conflict.kind)).toEqual(["cycle"]);
  });
});

describe("島（関係でつながらない塊）", () => {
  it("つながらない塊は別の島として横に並べ、重ねない", () => {
    const sketch = buildLocationSketch([
      ...harbor(),
      place("loc_011", "砦"),
      place("loc_012", "峠", [rel("direction", "砦", "西"), rel("distance", "砦", "徒歩1時間")]),
    ]);
    expect(sketch.islands).toBe(2);
    const first = ["港", "学校", "灯台"].map((name) => pointOf(sketch, name));
    const second = ["砦", "峠"].map((name) => pointOf(sketch, name));
    expect(new Set(first.map((point) => point.island)).size).toBe(1);
    expect(second[0].island).not.toBe(first[0].island);
    const firstRight = Math.max(...first.map((point) => point.x));
    const secondLeft = Math.min(...second.map((point) => point.x));
    expect(secondLeft).toBeGreaterThan(firstRight);
  });

  it("起点は関係のいちばん多い場所。選び直せる", () => {
    expect(pointOf(buildLocationSketch(harbor()), "港").placement).toBe("origin");
    const chosen = buildLocationSketch(harbor(), { origin: "loc_002" });
    expect(pointOf(chosen, "学校").placement).toBe("origin");
    // 選び直しても、決まった位置どうしの関係は変わらない
    const port = pointOf(chosen, "港");
    expect(pointOf(chosen, "学校").y).toBeLessThan(port.y);
    expect(pointOf(chosen, "灯台").x).toBeGreaterThan(port.x);
  });
});

describe("縮尺と乗り物", () => {
  it("乗り物が1種類なら換算しない（凡例の換算の表も出さない）", () => {
    const sketch = buildLocationSketch(harbor());
    expect(sketch.conversions).toBeNull();
  });

  it("乗り物が混ざるときだけ換算し、換算で置いた線は点線にする", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "港"),
      place("loc_002", "学校", [rel("direction", "港", "北"), rel("distance", "港", "徒歩1時間")]),
      place("loc_003", "灯台", [rel("direction", "港", "東"), rel("distance", "港", "徒歩2時間")]),
      place("loc_004", "王都", [rel("direction", "港", "西"), rel("distance", "港", "馬車で1時間")]),
    ]);
    expect(sketch.conversions).toEqual(TRAVEL_SPEEDS_KMH);
    expect(lineBetween(sketch, "港", "学校").dashed).toBe(false);
    const converted = lineBetween(sketch, "港", "王都");
    expect(converted.dashed).toBe(true);
    expect(converted.converted).toBe(true);
    expect(pointOf(sketch, "王都").settled).toBe(false);
    // 馬車1時間（8km）は徒歩1時間（4km）の2倍の長さ
    const port = pointOf(sketch, "港");
    expect(
      distance(port, pointOf(sketch, "王都")) / distance(port, pointOf(sketch, "学校"))
    ).toBeCloseTo(2, 5);
  });

  it("ほかとかけ離れて長い・短い距離は、図に収まる長さで描いてそう書く（決まった位置とは言わない）", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "港"),
      place("loc_002", "学校", [rel("direction", "港", "北"), rel("distance", "港", "徒歩10分")]),
      place("loc_003", "灯台", [rel("direction", "港", "東"), rel("distance", "港", "徒歩15分")]),
      place("loc_004", "王都", [rel("direction", "港", "西"), rel("distance", "港", "徒歩10日")]),
    ]);
    const far = lineBetween(sketch, "港", "王都");
    expect(far.clamped).toBe("shortened");
    expect(far.dashed).toBe(true);
    expect(far.label).toBe("西・徒歩10日（縮めて描画）");
    expect(pointOf(sketch, "王都").settled).toBe(false);
    // そろった近い2つは比のまま
    const port = pointOf(sketch, "港");
    expect(
      distance(port, pointOf(sketch, "灯台")) / distance(port, pointOf(sketch, "学校"))
    ).toBeCloseTo(1.5, 5);
    expect(lineBetween(sketch, "港", "学校").clamped).toBeNull();
    expect(distance(port, pointOf(sketch, "王都"))).toBeLessThanOrEqual(SKETCH_MAX_LENGTH + 1e-9);
  });

  it("乗り物が混ざる島では、乗り物の書いていない距離（三日の距離）を使わない", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "港"),
      place("loc_002", "学校", [rel("direction", "港", "北"), rel("distance", "港", "徒歩1時間")]),
      place("loc_003", "王都", [rel("direction", "港", "西"), rel("distance", "港", "馬車で1日")]),
      place("loc_004", "砂漠", [rel("direction", "港", "南"), rel("distance", "港", "三日の距離")]),
    ]);
    const line = lineBetween(sketch, "港", "砂漠");
    expect(line.label).toBe("南・距離未定");
    expect(line.dashed).toBe(true);
    expect(sketch.unused.map((entry) => entry.text)).toContain("砂漠は港から三日の距離");
  });
});

describe("食い違いの組", () => {
  it("どちらの記述も選ばず、あとの話の記述で仮に置き、線を赤く「食い違い：第3話／第7話」とする", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "港", [
        rel("direction", "学校", "北", { chapters: [7], evidence: "港は学校の北に見えた" }),
      ]),
      place("loc_002", "学校", [
        rel("direction", "港", "北", { chapters: [3], evidence: "学校は港の北の高台にある" }),
        rel("distance", "港", "徒歩10分", { chapters: [3] }),
      ]),
    ]);
    const line = lineBetween(sketch, "港", "学校");
    expect(line.conflict).toEqual({ index: 0, label: "食い違い：第3話／第7話" });
    // あとの話（第7話：港は学校の北）で置く → 港が上
    expect(pointOf(sketch, "港").y).toBeLessThan(pointOf(sketch, "学校").y);
    expect(sketch.conflicts[0]).toMatchObject({ index: 0, kind: "direction" });
  });

  it("話数の無い（作者が書いた）関係どうしの食い違いは、そう添える", () => {
    const sketch = buildLocationSketch([
      place("loc_001", "港", [rel("distance", "学校", "徒歩2時間")]),
      place("loc_002", "学校", [rel("distance", "港", "徒歩10分")]),
    ]);
    expect(lineBetween(sketch, "港", "学校").conflict?.label).toBe(
      "食い違い：作者が書いた関係どうし"
    );
  });
});

describe("作者が置いた位置", () => {
  it("作者が置いた点はその位置に置き、ほかの点は動かさない", () => {
    const plain = buildLocationSketch(harbor());
    const moved = harbor();
    moved[2] = { ...moved[2], sketchPosition: { x: 999, y: -40 } };
    const sketch = buildLocationSketch(moved);
    expect(pointOf(sketch, "灯台")).toMatchObject({ x: 999, y: -40, authorPlaced: true });
    for (const name of ["港", "学校"]) {
      expect(pointOf(sketch, name)).toMatchObject({
        x: pointOf(plain, name).x,
        y: pointOf(plain, name).y,
        authorPlaced: false,
      });
    }
  });

  it("関係と食い違う所へ置いたら、線に注意の印を付けるだけで止めない", () => {
    const base = buildLocationSketch(harbor());
    const port = pointOf(base, "港");
    const locations = harbor();
    // 学校は「港の北」なのに南へ置いた
    locations[1] = { ...locations[1], sketchPosition: { x: port.x, y: port.y + 100 } };
    const south = buildLocationSketch(locations);
    expect(lineBetween(south, "港", "学校").authorMismatch).toBe(true);
    // 北へ置いたなら印は付かない
    locations[1] = { ...locations[1], sketchPosition: { x: port.x + 10, y: port.y - 100 } };
    expect(lineBetween(buildLocationSketch(locations), "港", "学校").authorMismatch).toBe(false);
  });

  it("関係の無い場所でも、作者が置いたなら棚ではなく図に置く", () => {
    const sketch = buildLocationSketch([
      ...harbor(),
      place("loc_004", "王城", [], { sketchPosition: { x: 10, y: 20 } }),
    ]);
    expect(sketch.shelf).toEqual([]);
    expect(pointOf(sketch, "王城")).toMatchObject({ x: 10, y: 20, placement: "author" });
  });
});
