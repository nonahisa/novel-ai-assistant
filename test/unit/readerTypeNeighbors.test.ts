import { describe, expect, test } from "vitest";
import { READER_TYPES, type ReaderTypeId } from "../../src/core/readerTarget";
import {
  neighborToward,
  readerTypeNeighbors,
  READER_TYPE_IDS,
} from "../../src/core/readerTypeNeighbors";

/**
 * 読者タイプの隣り合い（設計書6.101、実装の順「4」）。
 *
 * **重なりが空のときに渡すのは、判定ではなく手段である。** その手段の
 * 2つ（ターゲットを寄せる・書ける範囲を広げる）は「隣へ一歩」の形でしか
 * 渡せないので、隣り合いが壊れると助言そのものが壊れる。
 *
 * ここで守るのは3つ。
 *
 * 1. **11タイプすべてに隣がある**——どこにいても一歩は踏み出せる
 * 2. **対称である**——向きによって関係が食い違わない
 * 3. **自分自身は隣ではない**——「同じところへ寄りましょう」は助言でない
 */

const ALL: readonly ReaderTypeId[] = READER_TYPE_IDS;

describe("隣り合いの土台", () => {
  test("11タイプすべてを、重複なく並べている", () => {
    expect([...ALL].sort()).toEqual(Object.keys(READER_TYPES).sort());
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  test("11タイプすべてに、隣が1つ以上ある", () => {
    for (const type of ALL) {
      expect(
        readerTypeNeighbors(type).length,
        `${READER_TYPES[type].label} に隣が無い`
      ).toBeGreaterThan(0);
    }
  });

  test("隣り合いは対称である（AがBの隣ならBもAの隣）", () => {
    for (const type of ALL) {
      for (const neighbor of readerTypeNeighbors(type)) {
        expect(
          readerTypeNeighbors(neighbor),
          `${READER_TYPES[type].label} → ${READER_TYPES[neighbor].label} が片道`
        ).toContain(type);
      }
    }
  });

  test("自分自身は隣に入らない", () => {
    for (const type of ALL) {
      expect(readerTypeNeighbors(type)).not.toContain(type);
    }
  });

  test("隣を書き換えても、次に呼んだときの答えは変わらない", () => {
    // 内側の表をそのまま渡していると、呼ぶ側の1行で全員の隣が壊れる
    const first = readerTypeNeighbors("light");
    first.push("omnivore");
    expect(readerTypeNeighbors("light")).not.toContain("omnivore");
  });
});

describe("隣の決め方（設計書6.101）", () => {
  test("角の層の隣は、主軸が同じもの・主軸と副軸を入れ替えたもの", () => {
    // 考察層（読み慣れ:読む姿勢）から見た隣
    const neighbors = readerTypeNeighbors("lore_deep");
    // ① 主軸が同じで副軸が違う
    expect(neighbors).toContain("lore_flow");
    expect(neighbors).toContain("lore_crave");
    // ② 主軸と副軸を入れ替えた（常連層）
    expect(neighbors).toContain("deep_lore");
    // 軸を2つまたぐ層は隣ではない
    expect(neighbors).not.toContain("crave_pure");
  });

  test("すきま層の隣は、副軸の無い3つ（軸を1つ上げた先）", () => {
    expect(readerTypeNeighbors("light").sort()).toEqual(
      ["crave_pure", "deep_pure", "lore_flow"].sort()
    );
  });

  test("雑食層は、角の9タイプすべての隣", () => {
    const neighbors = readerTypeNeighbors("omnivore");
    expect(neighbors).toHaveLength(9);
    expect(neighbors).not.toContain("light");
  });
});

describe("いちばん近い隣（neighborToward）", () => {
  test("同じ層へは、動く道を返さない", () => {
    expect(neighborToward("light", "light")).toBeUndefined();
  });

  test("行き先が隣なら、その隣を返す", () => {
    expect(neighborToward("lore_deep", "deep_lore")).toBe("deep_lore");
  });

  test("行き先の主軸を主軸に持つ隣を選ぶ", () => {
    // すきま層 → 考察層（読み慣れが主）。隣のうち読み慣れが主なのは回遊層
    expect(neighborToward("light", "lore_deep")).toBe("lore_flow");
  });

  test("主軸で決まらなければ、行き先の副軸を主軸に持つ隣を選ぶ", () => {
    // 考察層（読み慣れ:読む姿勢）から余韻層（求めるもの:読む姿勢）へ。
    // 隣に「求めるもの」が主の層は無いので、副軸の「読む姿勢」で選ぶ
    for (const neighbor of readerTypeNeighbors("lore_deep")) {
      expect(neighbor).not.toBe("crave_pure");
    }
    expect(neighborToward("lore_deep", "crave_deep")).toBe("deep_lore");
  });

  test("返ってくるのは、必ず隣である", () => {
    for (const from of ALL) {
      for (const toward of ALL) {
        const step = neighborToward(from, toward);
        if (from === toward) {
          expect(step).toBeUndefined();
          continue;
        }
        expect(step, `${from} → ${toward}`).toBeDefined();
        expect(readerTypeNeighbors(from)).toContain(step);
      }
    }
  });
});
