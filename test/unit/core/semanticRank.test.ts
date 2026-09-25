import { describe, expect, test } from "vitest";
import {
  findSimilarPairs,
  lineOfPassage,
  passagesWithin,
  rankByNearest,
  type VectorLookup,
} from "../../../src/core/semanticRank";

/**
 * ベクトル検索の共通の口のうち、VS Code に依らない計算（設計書6.19.10）。
 *
 * 守りたいのは3つ。
 *
 * - **索引に無いものは並べない。** 近さの分からないものを「遠い」と
 *   扱って末尾に置くと、件数の上限しだいで混ざる
 * - **下限より遠いものは渡さない。** 意味検索は必ず「いちばん近いもの」を
 *   返すので、下限が無いと関係の無い場面が材料に入る（6.74 の「関連が
 *   無ければ渡さない」）
 * - **同じ入力からは同じ並び。** 矛盾検知はこの並びで選んだ抜粋のハッシュを
 *   キャッシュの鍵に混ぜる（揺れると同じ鍵に違う材料の答えが入る）
 */

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

function lookupOf(entries: Record<string, Float32Array>): VectorLookup {
  return (hash) => entries[hash];
}

describe("rankByNearest（複数の問いのうち、いちばん近いもので並べる）", () => {
  const lookup = lookupOf({
    a: vec(1, 0, 0),
    b: vec(0, 1, 0),
    c: vec(0.9, 0.1, 0),
    d: vec(0, 0, 1),
  });
  const candidates = [
    { id: "A", hash: "a" },
    { id: "B", hash: "b" },
    { id: "C", hash: "c" },
    { id: "D", hash: "d" },
    { id: "X", hash: "索引に無い" },
  ];

  test("問いのどれか1つに近ければ上に来る", () => {
    const ranked = rankByNearest([vec(1, 0, 0), vec(0, 1, 0)], candidates, lookup, {
      limit: 3,
    });
    expect(ranked.map((hit) => hit.id)).toEqual(["A", "B", "C"]);
  });

  test("索引に無いものは並べない", () => {
    const ranked = rankByNearest([vec(1, 1, 1)], candidates, lookup, { limit: 10 });
    expect(ranked.map((hit) => hit.id)).not.toContain("X");
    expect(ranked).toHaveLength(4);
  });

  test("下限より遠いものは落とす（関係の無い場面を渡さない）", () => {
    const ranked = rankByNearest([vec(1, 0, 0)], candidates, lookup, {
      limit: 10,
      minScore: 0.5,
    });
    expect(ranked.map((hit) => hit.id)).toEqual(["A", "C"]);
  });

  test("近さが同じなら、渡した順を保つ（並びが揺れない）", () => {
    const tie = lookupOf({ p: vec(1, 0), q: vec(1, 0), r: vec(1, 0) });
    const ranked = rankByNearest(
      [vec(1, 0)],
      [
        { id: "R", hash: "r" },
        { id: "P", hash: "p" },
        { id: "Q", hash: "q" },
      ],
      tie,
      { limit: 3 }
    );
    expect(ranked.map((hit) => hit.id)).toEqual(["R", "P", "Q"]);
  });

  test("問いが無ければ空（何かを返して関係があるように見せない）", () => {
    expect(rankByNearest([], candidates, lookup, { limit: 3 })).toEqual([]);
  });
});

describe("findSimilarPairs（別の話どうしの、近い場面の組）", () => {
  const items = [
    { id: "1-0", hash: "h10", group: "第1話", position: 0 },
    { id: "1-1", hash: "h11", group: "第1話", position: 1 },
    { id: "2-0", hash: "h20", group: "第2話", position: 0 },
    { id: "3-0", hash: "h30", group: "第3話", position: 0 },
    { id: "3-1", hash: "h31", group: "第3話", position: 1 },
  ];
  const lookup = lookupOf({
    h10: vec(1, 0, 0),
    h11: vec(0.99, 0.05, 0),
    h20: vec(0, 1, 0),
    h30: vec(0.98, 0, 0.1),
    h31: vec(0, 0.2, 1),
  });

  test("同じ話の中の組は出さない", async () => {
    const pairs = await findSimilarPairs(items, lookup, { minScore: 0.5, limit: 10 });
    for (const pair of pairs) {
      expect(pair.a.split("-")[0]).not.toBe(pair.b.split("-")[0]);
    }
  });

  test("隣り合う場面が同じ相手に近いときは、1組にまとめる", async () => {
    // 第1話の0番と1番は重なりを持つ隣どうし。どちらも第3話の0番に近い
    const pairs = await findSimilarPairs(items, lookup, { minScore: 0.5, limit: 10 });
    const withThird = pairs.filter(
      (pair) => pair.b === "3-0" || pair.a === "3-0"
    );
    expect(withThird).toHaveLength(1);
  });

  test("下限より遠い組は出さない", async () => {
    const pairs = await findSimilarPairs(items, lookup, { minScore: 0.9, limit: 10 });
    expect(pairs.every((pair) => pair.score >= 0.9)).toBe(true);
    expect(pairs.some((pair) => pair.a === "2-0" || pair.b === "2-0")).toBe(false);
  });

  test("近い順に並び、上限で切る", async () => {
    // 場面を分け合わない3組（R8 の畳みで1組にまとまらないように、
    // どの場面も1つの組にしか出ない作り物にしてある）
    const separate = [
      { id: "1-0", hash: "p", group: "第1話", position: 0 },
      { id: "2-0", hash: "p2", group: "第2話", position: 0 },
      { id: "3-0", hash: "q", group: "第3話", position: 0 },
      { id: "4-0", hash: "q2", group: "第4話", position: 0 },
      { id: "5-0", hash: "r", group: "第5話", position: 0 },
      { id: "6-0", hash: "r2", group: "第6話", position: 0 },
    ];
    const apart = lookupOf({
      p: vec(1, 0, 0),
      p2: vec(0.99, 0.1, 0),
      q: vec(0, 1, 0),
      q2: vec(0, 0.95, 0.3),
      r: vec(0, 0, 1),
      r2: vec(0.2, 0, 0.9),
    });
    const pairs = await findSimilarPairs(separate, apart, { minScore: 0.5, limit: 2 });
    expect(pairs).toHaveLength(2);
    expect(pairs[0].score).toBeGreaterThanOrEqual(pairs[1].score);
  });

  test("途中で止められる（止めたら、そこまでの組を返す）", async () => {
    let asked = 0;
    const pairs = await findSimilarPairs(items, lookup, {
      minScore: 0,
      limit: 10,
      isCancelled: () => ++asked > 1,
    });
    expect(Array.isArray(pairs)).toBe(true);
  });
});

describe("passagesWithin（チャンクの中に丸ごと入っている場面）", () => {
  test("改行の違いを揃えて、含まれるものだけを返す", () => {
    const chunk = "一行目\r\n二行目\r\n三行目\r\n四行目";
    const found = passagesWithin(chunk, [
      { id: "a", text: "二行目\n三行目" },
      { id: "b", text: "五行目" },
      { id: "c", text: "  一行目\n二行目  " },
    ]);
    expect(found).toEqual(["a", "c"]);
  });

  test("空の場面は含まれていても数えない", () => {
    expect(passagesWithin("本文", [{ id: "a", text: "   " }])).toEqual([]);
  });
});

describe("lineOfPassage（場面が何行目から始まるか）", () => {
  test("最初の中身のある行で探す（1始まり）", () => {
    const file = "題\n\n一行目\n二行目\n三行目\n";
    expect(lineOfPassage(file, "\n二行目\n三行目")).toBe(4);
  });

  test("1行目が他所にもあるときは、続く行まで合うところを採る", () => {
    const file = "「はい」\n別の行\n「はい」\n続きの行\n";
    expect(lineOfPassage(file, "「はい」\n続きの行")).toBe(3);
  });

  test("見つからなければ undefined（でたらめな行へ飛ばさない）", () => {
    expect(lineOfPassage("本文", "無い行")).toBeUndefined();
  });
});
