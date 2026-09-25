import { describe, expect, test } from "vitest";
import { findSimilarPairs, type VectorLookup } from "../../../src/core/semanticRank";

/**
 * 似た場面の検出で、同じ場面が上位に何度も出る（残課題 R8 の前半）。
 *
 * **再現**：ギルド第1話の同じ場面が、上位12組のうち5組に出た（引継ぎ書 8章
 * 2026-09-25 深夜〈2巡目〉の「8. 小さなこと」）。隣どうしの畳み
 * （`isNeighbor`）は「**両方の側**が既に採った組の隣」のときしか効かないので、
 * 片側が同じ場面で相手が毎回違う組は、何組でも並ぶ。ありふれた場面（受付の
 * やりとりなど）が1つあると、一覧の上を埋めてしまう。
 *
 * 同じ場面（と重なった隣の場面）が片側に出る組は、最初の組へまとめる。
 * **黙って捨てない**——まとめた相手は、最初の組の `others` に残す。
 */

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe("似た場面：同じ場面を上位に何度も並べない", () => {
  // 第1話の2番（受付の場面）は、第2・4・6話のそれぞれの場面と近い。
  // 第3話の0番と第5話の0番は、互いにだけ近い（別の本物の組）
  const items = [
    { id: "1-1", hash: "h11", group: "第1話", position: 1 },
    { id: "1-2", hash: "h12", group: "第1話", position: 2 },
    { id: "2-0", hash: "h20", group: "第2話", position: 0 },
    { id: "3-0", hash: "h30", group: "第3話", position: 0 },
    { id: "4-0", hash: "h40", group: "第4話", position: 0 },
    { id: "5-0", hash: "h50", group: "第5話", position: 0 },
    { id: "6-0", hash: "h60", group: "第6話", position: 0 },
  ];
  const vectors: Record<string, Float32Array> = {
    h11: vec(0.97, 0.2, 0, 0),
    h12: vec(1, 0, 0, 0),
    h20: vec(0.99, 0.1, 0.05, 0),
    h40: vec(0.98, 0, 0.15, 0),
    h60: vec(0.97, 0.05, 0, 0.2),
    h30: vec(0, 0, 0, 1),
    h50: vec(0, 0.05, 0, 0.99),
  };
  const lookup: VectorLookup = (hash) => vectors[hash];

  test("同じ場面（と隣の場面）が片側に出る組は、1組だけ並ぶ", async () => {
    const pairs = await findSimilarPairs(items, lookup, { minScore: 0.9, limit: 10 });

    const withReception = pairs.filter((pair) =>
      [pair.a, pair.b].some((id) => id === "1-1" || id === "1-2")
    );
    expect(withReception).toHaveLength(1);
    // 別の本物の組は残る
    expect(
      pairs.some(
        (pair) => [pair.a, pair.b].sort().join("|") === "3-0|5-0"
      )
    ).toBe(true);
  });

  test("まとめた相手は、黙って捨てずに最初の組へ残す", async () => {
    const pairs = await findSimilarPairs(items, lookup, { minScore: 0.9, limit: 10 });
    const reception = pairs.find((pair) =>
      [pair.a, pair.b].some((id) => id === "1-1" || id === "1-2")
    )!;

    const partners = new Set([
      reception.a,
      reception.b,
      ...(reception.others ?? []).map((other) => other.id),
    ]);
    for (const id of ["2-0", "4-0", "6-0"]) {
      expect(partners.has(id), `${id} が消えている`).toBe(true);
    }
    // どちらの側に近いのかも持つ（画面で「第1話（2）はほかに…とも近い」と出すため）
    for (const other of reception.others ?? []) {
      expect([reception.a, reception.b]).toContain(other.near);
    }
  });

  test("まとめても、並べる組の数の上限は本物の組で数える", async () => {
    const pairs = await findSimilarPairs(items, lookup, { minScore: 0.9, limit: 2 });
    expect(pairs).toHaveLength(2);
  });
});
