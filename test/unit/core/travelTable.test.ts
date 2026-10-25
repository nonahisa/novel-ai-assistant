import { describe, expect, it } from "vitest";
import { buildTravelTable, containmentOf } from "../../../src/core/travelTable";
import {
  parseLocation,
  type Location,
  type LocationRelation,
} from "../../../src/models/location";

/**
 * 移動の照合の所要時間の表（設計書6.88。作者の裁定 2026-10-25 夜：
 * いちばん速い値、1日以上の組だけ）。
 */

function relation(
  kind: LocationRelation["kind"],
  target: string,
  value: string | null = null
): LocationRelation {
  return {
    kind,
    target,
    targetId: null,
    value,
    chapters: [],
    evidence: null,
    authorLocked: true,
  };
}

function location(
  id: string,
  name: string,
  relations: LocationRelation[] = [],
  extra: Partial<Location> = {}
): Location {
  return { ...parseLocation({ id, name }), relations, ...extra };
}

describe("所要時間の表", () => {
  it("書かれた中でいちばん速い値を、向きを問わず1組にする", () => {
    const table = buildTravelTable([
      location("loc_1", "王都", [relation("distance", "港町", "徒歩で六日")]),
      location("loc_2", "港町", [relation("distance", "王都", "馬で三日")]),
    ]);
    expect(table.travelTimes).toEqual([{ from: "loc_2", to: "loc_1", minDays: 3 }]);
    expect(table.stats).toEqual({
      distanceRelations: 2,
      readable: 2,
      pairs: 1,
      comparedPairs: 1,
    });
  });

  it("1日に満たない組は載せない", () => {
    const table = buildTravelTable([
      location("loc_1", "学校", [relation("distance", "駅", "徒歩10分")]),
      location("loc_2", "駅"),
    ]);
    expect(table.travelTimes).toEqual([]);
    expect(table.stats.pairs).toBe(1);
  });

  it("読めない値・台帳に無い相手は入れない", () => {
    const table = buildTravelTable([
      location("loc_1", "王都", [
        relation("distance", "港町", "数日"),
        relation("distance", "竜の谷", "馬で三日"),
        relation("distance", "港町", "飛竜で一日"),
      ]),
      location("loc_2", "港町"),
    ]);
    expect(table.travelTimes).toEqual([]);
    expect(table.stats.readable).toBe(0);
  });

  /** A→B と B→C から A→C を作らない */
  it("3か所以上をつないで推し量らない", () => {
    const table = buildTravelTable([
      location("loc_1", "王都", [relation("distance", "宿場", "馬で二日")]),
      location("loc_2", "宿場", [relation("distance", "港町", "馬で一日")]),
      location("loc_3", "港町"),
    ]);
    expect(table.travelTimes.map((entry) => [entry.from, entry.to].sort())).toEqual([
      ["loc_1", "loc_2"],
      ["loc_2", "loc_3"],
    ]);
  });

  it("片方がもう片方の中にある組は載せない（地域の欄でも）", () => {
    const table = buildTravelTable([
      location("loc_1", "港町"),
      location("loc_2", "港", [relation("distance", "港町", "一日")], {
        region: "港町",
      }),
    ]);
    expect(table.travelTimes).toEqual([]);
  });
});

describe("入れ子", () => {
  it("中の関係をたどり、輪になっていても止まる", () => {
    const locations = [
      location("loc_1", "南部", [relation("within", "港")]),
      location("loc_2", "港町", [relation("within", "南部")]),
      location("loc_3", "港", [relation("within", "港町")]),
    ];
    const contains = containmentOf(locations);
    expect(contains("loc_3", "loc_1")).toBe(true);
    expect(contains("loc_3", "loc_9")).toBe(false);
  });
});
