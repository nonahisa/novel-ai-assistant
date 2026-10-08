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
  test("関係の欄が無い古いファイルも読める（欄は足さない）", () => {
    const location = parseLocation({ id: "loc_001", name: "港" });
    expect(location).not.toHaveProperty("relations");
  });

  test("空の関係の欄は、読んだ時点で外す", () => {
    const location = parseLocation({ id: "loc_001", name: "港", relations: [] });
    expect(location).not.toHaveProperty("relations");
  });

  test("関係の無い場所を読み書きしても、JSON が1字も変わらない", () => {
    // 関係の欄ができる前の版が書いたファイル。保存の形（2字下げ＋末尾の改行）も揃える
    const saved: Record<string, unknown> = {
      ...emptyLocation("loc_001", "港"),
      aliases: ["港湾"],
      summary: "町の南の港。",
      appearedChapters: [1, 3],
      evidence: "港に船が着いた",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    delete saved.relations;
    const text = `${JSON.stringify(saved, null, 2)}\n`;

    const reread = parseLocation(JSON.parse(text));
    expect(`${JSON.stringify(reread, null, 2)}\n`).toBe(text);
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

  test("新しい場所は関係の欄を持たない", () => {
    expect(emptyLocation("loc_001", "港")).not.toHaveProperty("relations");
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
