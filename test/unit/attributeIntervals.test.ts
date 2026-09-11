import { describe, expect, it } from "vitest";
import {
  buildAttributeIntervals,
  compareFactPosition,
  orderFacts,
} from "../../src/core/attributeIntervals";
import type { StoryFact } from "../../src/models/storyFact";

/**
 * 区間の状態表（設計書6.88.6）。
 *
 * **変化の記録が無いまま値が変わったら、区間は閉じずに重ねる。**
 * 閉じてしまうと「12日目は銀、14日目は黒」がきれいに並んでしまい、
 * 矛盾が消える。重なりを残すことが、そのまま照合の候補になる。
 */

function fact(overrides: Partial<StoryFact> & { id: string }): StoryFact {
  return {
    id: overrides.id,
    chapter: 1,
    lineRange: [1, 1],
    subject: "char_001",
    predicate: "髪の色",
    value: "銀",
    kind: "static",
    storyTime: null,
    modality: "narration",
    pov: null,
    speaker: null,
    topic: null,
    ...overrides,
  };
}

describe("区間を組む", () => {
  it("同じ値が続くあいだは1つの区間にまとめる", () => {
    const intervals = buildAttributeIntervals([
      fact({ id: "f1", chapter: 1, storyTime: { day: 1, part: "朝" } }),
      fact({ id: "f2", chapter: 3, storyTime: { day: 5, part: "朝" } }),
      fact({ id: "f3", chapter: 7, storyTime: { day: 9, part: "朝" } }),
    ]);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].sources).toEqual(["f1", "f2", "f3"]);
    expect(intervals[0].end).toBeNull();
  });

  it("変化イベントがあれば、その位置で区間が切れる", () => {
    const intervals = buildAttributeIntervals([
      fact({ id: "f1", chapter: 1, storyTime: { day: 1, part: "朝" } }),
      fact({
        id: "e1",
        chapter: 5,
        kind: "event",
        value: "黒く染めた",
        storyTime: { day: 5, part: "昼" },
      }),
      fact({
        id: "f2",
        chapter: 7,
        value: "黒",
        storyTime: { day: 9, part: "朝" },
      }),
    ]);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toMatchObject({ value: "銀" });
    expect(intervals[0].end).toMatchObject({ storyTime: { day: 5 } });
    expect(intervals[1]).toMatchObject({ value: "黒" });
    expect(intervals[1].end).toBeNull();
  });

  it("変化の記録が無いのに値が変わったら、区間を重ねて始める", () => {
    const intervals = buildAttributeIntervals([
      fact({ id: "f1", chapter: 1, storyTime: { day: 1, part: "朝" } }),
      fact({
        id: "f2",
        chapter: 7,
        value: "黒",
        storyTime: { day: 9, part: "朝" },
      }),
    ]);
    expect(intervals).toHaveLength(2);
    // どちらも閉じていない＝重なっている。これが照合の候補になる
    expect(intervals[0].end).toBeNull();
    expect(intervals[1].end).toBeNull();
  });

  it("支える事実のうち、いちばん強い modality を採る", () => {
    const intervals = buildAttributeIntervals([
      fact({ id: "f1", chapter: 1, modality: "rumor" }),
      fact({ id: "f2", chapter: 3, modality: "narration" }),
      fact({ id: "f3", chapter: 5, modality: "dialogue" }),
    ]);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].modality).toBe("narration");
  });

  it("一度でも state として書かれた属性は、変わりうる属性として扱う", () => {
    const intervals = buildAttributeIntervals([
      fact({ id: "f1", predicate: "所在", value: "教室", kind: "static" }),
      fact({
        id: "f2",
        chapter: 3,
        predicate: "所在",
        value: "教室",
        kind: "state",
      }),
    ]);
    expect(intervals[0].kind).toBe("state");
  });

  it("人物と項目が違えば、別の区間になる", () => {
    const intervals = buildAttributeIntervals([
      fact({ id: "f1", subject: "char_001", value: "銀" }),
      fact({ id: "f2", subject: "char_002", value: "黒" }),
    ]);
    expect(intervals).toHaveLength(2);
    expect(intervals.map((interval) => interval.subject).sort()).toEqual([
      "char_001",
      "char_002",
    ]);
  });

  it("知識の事実は状態表に入れない", () => {
    const intervals = buildAttributeIntervals([
      fact({ id: "k1", kind: "knowledge", topic: "王の死", value: "知った" }),
    ]);
    expect(intervals).toHaveLength(0);
  });
});

describe("事実を並べる", () => {
  it("時期が分かるものは時期の順（本文の順と食い違っても）", () => {
    const ordered = orderFacts([
      fact({ id: "後", chapter: 1, lineRange: [1, 1], storyTime: { day: 9, part: "朝" } }),
      fact({ id: "前", chapter: 2, lineRange: [1, 1], storyTime: { day: 3, part: "朝" } }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["前", "後"]);
  });

  /**
   * **時期が null の事実は、話数と行の順で挟み込む**（6.88.4）。
   * 直前にあった「時期の分かる事実」の目盛りを借りるので、
   * 書かれた場所のとおりの位置に収まる。
   */
  it("時期が分からないものは、書かれた場所で挟み込む", () => {
    const ordered = orderFacts([
      fact({ id: "a", chapter: 1, storyTime: { day: 3, part: "朝" } }),
      fact({ id: "b", chapter: 2, storyTime: null }),
      fact({ id: "c", chapter: 3, storyTime: { day: 9, part: "朝" } }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("時期の分かる事実が前に無ければ、いちばん前に置く", () => {
    const ordered = orderFacts([
      fact({ id: "a", chapter: 1, storyTime: null }),
      fact({ id: "b", chapter: 2, storyTime: { day: 9, part: "朝" } }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("置き場所を比べる", () => {
  it("時期があれば時期で、無ければ本文の位置で決める", () => {
    expect(
      compareFactPosition(
        { storyTime: { day: 3, part: "朝" }, chapter: 9, line: 1 },
        { storyTime: { day: 9, part: "朝" }, chapter: 1, line: 1 }
      )
    ).toBe(-1);
    expect(
      compareFactPosition(
        { storyTime: null, chapter: 1, line: 5 },
        { storyTime: null, chapter: 1, line: 9 }
      )
    ).toBe(-1);
  });

  it("同じ日で区分が分からなければ、本文の位置で決める", () => {
    expect(
      compareFactPosition(
        { storyTime: { day: 3, part: null }, chapter: 1, line: 1 },
        { storyTime: { day: 3, part: "朝" }, chapter: 2, line: 1 }
      )
    ).toBe(-1);
  });
});
