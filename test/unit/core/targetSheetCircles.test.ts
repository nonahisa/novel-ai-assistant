import { describe, expect, test } from "vitest";
import { targetSheetCircles } from "../../../src/core/targetSheetCircles";
import type { ReaderActual, ReaderScores } from "../../../src/models/readerProfile";

/**
 * シートの中の3つの輪（設計書6.108.6）。
 *
 * 統合の形では、3つの輪は**作者の読者タイプ × 狙い × 本文の実像**になる。
 * 6.101 の3つの輪（書けたもの・書きたいもの・読者が読みたいもの）を、
 * 1段目で聞いた「狙い」を軸に組み直したものである。
 *
 * 見張るのは3つ。
 *
 * 1. **材料の無い輪は推測で埋めない**（何が足りないかと、埋め方を言う）
 * 2. **2点未満のずれは「離れている」と言わない**（`READER_GAP_THRESHOLD`）
 * 3. **上下を作らない**（どちらが正しいとも言わない）
 */

const LORE_DEEP: ReaderScores = { familiarity: 6, posture: 3, craving: 0 };
const LIGHT: ReaderScores = { familiarity: 0, posture: 0, craving: 0 };

function actualOf(scores: ReaderScores): ReaderActual {
  return {
    scores,
    evidence: [],
    basis: "冒頭",
    model: "test",
    updatedAt: "2026-09-23T00:00:00.000Z",
  };
}

describe("3つの輪がそろっているとき", () => {
  test("3つとも同じ層なら、3本とも重なっている", () => {
    const circles = targetSheetCircles({
      authorReader: { scores: LORE_DEEP },
      aim: ["lore_deep"],
      actual: actualOf(LORE_DEEP),
    });

    expect(circles.edges.map((edge) => edge.key)).toEqual([
      "author-aim",
      "aim-actual",
      "author-actual",
    ]);
    expect(circles.edges.every((edge) => !edge.apart)).toBe(true);
    expect(circles.missing).toEqual([]);
  });

  test("作者の読み方と狙いが2点以上離れていれば、離れていると言う", () => {
    const circles = targetSheetCircles({
      authorReader: { scores: LIGHT },
      aim: ["lore_deep"],
      actual: actualOf(LORE_DEEP),
    });

    const edge = circles.edges.find((entry) => entry.key === "author-aim");
    expect(edge?.apart).toBe(true);
    const text = edge?.lines.join("\n") ?? "";
    expect(text).toContain("すきま層");
    expect(text).toContain("考察層");
    // 上下を作らない
    expect(text).toContain("どちらが正しいとも言いません");
  });

  test("中心から1点ずつずれていても、同じ層なら重なっていると言う", () => {
    // 考察層の中心 6/3/0 に対して 5/2/1。どの軸も選択肢1つぶんの差で、
    // 問いの読み方でも動く幅である
    const circles = targetSheetCircles({
      authorReader: { scores: { familiarity: 5, posture: 2, craving: 1 } },
      aim: ["lore_deep"],
    });

    const edge = circles.edges.find((entry) => entry.key === "author-aim");
    expect(edge?.apart).toBe(false);
    expect(edge?.lines.join("\n")).toContain("重なっています");
  });

  test("狙いが2つなら、狙いごとに突き合わせる", () => {
    const circles = targetSheetCircles({
      authorReader: { scores: LORE_DEEP },
      aim: ["lore_deep", "light"],
      actual: actualOf(LORE_DEEP),
    });

    expect(
      circles.edges.filter((edge) => edge.key === "author-aim")
    ).toHaveLength(2);
    expect(
      circles.edges.filter((edge) => edge.key === "aim-actual")
    ).toHaveLength(2);
  });

  test("狙いと実像の辺は、一致度の数字を添える（数字は機械が出したもの）", () => {
    const circles = targetSheetCircles({
      aim: ["light"],
      actual: actualOf(LORE_DEEP),
    });

    const edge = circles.edges.find((entry) => entry.key === "aim-actual");
    expect(edge?.apart).toBe(true);
    expect(edge?.lines.join("\n")).toMatch(/一致度 \d+/);
  });
});

describe("材料の無い輪は、推測で埋めない", () => {
  test("作者の読者タイプが無ければ、その輪が絡む辺は出さず、埋め方を言う", () => {
    const circles = targetSheetCircles({
      aim: ["lore_deep"],
      actual: actualOf(LORE_DEEP),
    });

    expect(circles.edges.map((edge) => edge.key)).toEqual(["aim-actual"]);
    expect(circles.missing.join("\n")).toContain("あなた自身の読者タイプ");
  });

  test("狙いが無ければ、狙いが絡む辺は出さない", () => {
    const circles = targetSheetCircles({
      authorReader: { scores: LORE_DEEP },
      aim: [],
      actual: actualOf(LORE_DEEP),
    });

    expect(circles.edges.map((edge) => edge.key)).toEqual(["author-actual"]);
    expect(circles.missing.join("\n")).toContain("狙い");
  });

  test("本文の実像が無ければ、実像が絡む辺は出さない", () => {
    const circles = targetSheetCircles({
      authorReader: { scores: LORE_DEEP },
      aim: ["lore_deep"],
    });

    expect(circles.edges.map((edge) => edge.key)).toEqual(["author-aim"]);
    expect(circles.missing.join("\n")).toContain("本文の実像");
  });

  test("何も無ければ、辺は0本で、3つとも足りないと言う", () => {
    const circles = targetSheetCircles({ aim: [] });

    expect(circles.edges).toEqual([]);
    expect(circles.missing).toHaveLength(3);
  });
});
