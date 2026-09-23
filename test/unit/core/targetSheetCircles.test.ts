import { describe, expect, test } from "vitest";
import {
  needsBridge,
  targetSheetCircles,
} from "../../../src/core/targetSheetCircles";
import { READER_TYPES, resolveReaderType } from "../../../src/core/readerTarget";
import { readerTypeNeighbors } from "../../../src/core/readerTypeNeighbors";
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

/**
 * 近づける道（0.82.2 まで単独の3つの輪の紙にあった。作者の裁定、
 * 2026-09-23 でシートへ移した）。前の紙のテストをここへ移してある。
 *
 * 1. **辺が2本以上あって、すべて離れているときだけ**出す。1本では
 *    「重なりが空」と言い切れない
 * 2. **「重なっていません」とは書かない**——判定ではなく手段を渡す
 * 3. **いきなり遠くへ飛ばさない**（隣へ一歩の形で名指しする）
 */
describe("近づける道", () => {
  /** 開拓層寄り（読み慣れと求めるものが高い） */
  const LORE_CRAVE: ReaderScores = { familiarity: 6, posture: 0, craving: 6 };

  test("辺が2本以上あって、すべて離れているときだけ出す", () => {
    const circles = targetSheetCircles({
      authorReader: { scores: LORE_DEEP },
      aim: ["light"],
      actual: actualOf(LORE_CRAVE),
    });

    expect(circles.edges).toHaveLength(3);
    expect(circles.edges.every((edge) => edge.apart)).toBe(true);
    expect(needsBridge(circles.edges)).toBe(true);
    expect(circles.bridge?.edgeCount).toBe(3);
  });

  test("辺が1本しか無いときは出さない", () => {
    const circles = targetSheetCircles({
      authorReader: { scores: LORE_DEEP },
      aim: ["light"],
    });

    expect(circles.edges).toHaveLength(1);
    expect(circles.edges[0].apart).toBe(true);
    expect(needsBridge(circles.edges)).toBe(false);
    expect(circles.bridge).toBeUndefined();
  });

  test("1本でも離れていなければ出さない", () => {
    const circles = targetSheetCircles({
      authorReader: { scores: LORE_DEEP },
      aim: ["lore_deep"],
      actual: actualOf(LORE_CRAVE),
    });

    expect(circles.edges.length).toBeGreaterThanOrEqual(2);
    expect(circles.edges.some((edge) => !edge.apart)).toBe(true);
    expect(circles.bridge).toBeUndefined();
  });

  test("狙いが2つで、片方が重なっていれば出さない（重なりは空ではない）", () => {
    const circles = targetSheetCircles({
      authorReader: { scores: LORE_DEEP },
      aim: ["light", "lore_deep"],
      actual: actualOf(LORE_CRAVE),
    });

    expect(circles.bridge).toBeUndefined();
  });

  test("動かせるところを3つ、隣へ一歩の形で渡す", () => {
    const bridge = targetSheetCircles({
      authorReader: { scores: LORE_DEEP },
      aim: ["light"],
      actual: actualOf(LORE_CRAVE),
    }).bridge;

    expect(bridge?.routes.map((route) => route.circle)).toEqual([
      "aim",
      "actual",
      "author",
    ]);
    const text = (bridge?.routes ?? [])
      .map((route) => `${route.label} ${route.text}`)
      .join("\n");
    expect(text).toContain("読んでもらいたい読者を動かす");
    expect(text).toContain("書けているものを動かす");
    expect(text).toContain("書きたいものを動かす");
    // 宛先は狙い（シートでは「読者が読みたいもの」の輪が狙いになった）
    expect(text).toContain("いまの狙い「すきま層」の隣は");
    // 名指しする（どこへ寄せるか分からない案内にしない）
    expect(text).toMatch(/隣の「[^」]+」まで一歩|その隣です。一歩で届きます/);
    // 「重なっていません」とは書かない。「書けるもの」とも書かない
    expect(text).not.toContain("重なっていません");
    expect(text).not.toContain("書けるもの");
  });

  test("狙いが実像のすぐ隣なら、「隣の狙いまで一歩」と同じ層を2度呼ばない", () => {
    // 実像の層から見て、狙いが隣にある組を探す（隣の表に依らず測る）
    const actualType = resolveReaderType(LORE_CRAVE);
    const aim = readerTypeNeighbors(actualType)[0];
    const circles = targetSheetCircles({
      authorReader: { scores: { familiarity: 0, posture: 6, craving: 0 } },
      aim: [aim],
      actual: actualOf(LORE_CRAVE),
    });
    const route = circles.bridge?.routes.find((entry) => entry.circle === "actual");
    expect(route).toBeDefined();
    const label = READER_TYPES[aim].label;
    expect(route?.text).not.toContain(`隣の「${label}」まで一歩`);
    expect(route?.text).toContain("一歩で届きます");
  });
});
