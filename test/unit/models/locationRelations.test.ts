import { describe, expect, test } from "vitest";
import {
  describeLocationRelation,
  emptyLocation,
  parseLocation,
  type LocationRelation,
} from "../../../src/models/location";

/**
 * 場所の位置関係の記録の形（設計書6.93.2）。
 *
 * 古いファイル（関係の欄が無い）を読めること、壊れた関係は直さず止めること、
 * 1行の書き方がパネルと設定資料集で同じになることを見る。
 */

function relation(overrides: Partial<LocationRelation>): LocationRelation {
  return {
    kind: "within",
    target: "港町",
    targetId: null,
    value: null,
    chapters: [],
    evidence: null,
    authorLocked: false,
    ...overrides,
  };
}

describe("位置関係の読み込み", () => {
  test("関係の欄が無い古いファイルも読める（空の関係になる）", () => {
    const location = parseLocation({ id: "loc_001", name: "港" });
    expect(location.relations).toEqual([]);
  });

  test("欠けた欄は既定値で補う", () => {
    const location = parseLocation({
      id: "loc_001",
      name: "学校",
      relations: [{ kind: "direction", target: "港", value: "北" }],
    });
    expect(location.relations).toEqual([
      relation({ kind: "direction", target: "港", value: "北" }),
    ]);
  });

  test("知らない種類は直さずに止める", () => {
    expect(() =>
      parseLocation({
        id: "loc_001",
        name: "学校",
        relations: [{ kind: "near", target: "港" }],
      })
    ).toThrow("relations[0].kind");
  });

  test("種類が無い関係は止める", () => {
    expect(() =>
      parseLocation({
        id: "loc_001",
        name: "学校",
        relations: [{ target: "港" }],
      })
    ).toThrow("relations[0].kind");
  });

  test("相手が空の関係は止める", () => {
    expect(() =>
      parseLocation({
        id: "loc_001",
        name: "学校",
        relations: [{ kind: "adjacent", target: " " }],
      })
    ).toThrow("relations[0].target");
  });

  test("方角・距離なのに値が無い関係は止める", () => {
    expect(() =>
      parseLocation({
        id: "loc_001",
        name: "学校",
        relations: [{ kind: "distance", target: "港" }],
      })
    ).toThrow("relations[0].value");
  });

  test("新しい場所は関係を空で持つ", () => {
    expect(emptyLocation("loc_001", "港").relations).toEqual([]);
  });
});

describe("1行の書き方", () => {
  test.each([
    [relation({ kind: "within", target: "港町" }), "港町の中"],
    [relation({ kind: "adjacent", target: "防波堤" }), "防波堤に隣接"],
    [relation({ kind: "direction", target: "港", value: "北" }), "港の北"],
    [relation({ kind: "distance", target: "港", value: "徒歩10分" }), "港から徒歩10分"],
  ])("%j を %s と書く", (entry, expected) => {
    expect(describeLocationRelation(entry)).toBe(expected);
  });
});
