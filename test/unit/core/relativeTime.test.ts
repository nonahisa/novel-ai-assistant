import { describe, expect, it } from "vitest";
import {
  compareRelativeTime,
  formatRelativeTime,
  isOrderUnknown,
  parseRelativeTime,
} from "../../src/core/relativeTime";

/**
 * 相対時期の読み（設計書6.88.4）。
 *
 * 作者の裁定（2026-09-11）：作中時刻は暦ではなく**起点からの相対**で持つ。
 * **読めなければ `null`。推測で埋めない。**
 */

describe("相対時期を読む", () => {
  it("day+14 夕 を読む", () => {
    expect(parseRelativeTime("day+14 夕")).toEqual({ day: 14, part: "夕" });
  });

  it("区分が無ければ part は null（その日のいつか）", () => {
    expect(parseRelativeTime("day+14")).toEqual({ day: 14, part: null });
  });

  it("14日目 夕 を読む", () => {
    expect(parseRelativeTime("14日目 夕")).toEqual({ day: 14, part: "夕" });
  });

  it("起点より前は負になる", () => {
    expect(parseRelativeTime("day-3 朝")).toEqual({ day: -3, part: "朝" });
  });

  it("3日目の夜 のように「の」が挟まっても読む", () => {
    expect(parseRelativeTime("3日目の夜")).toEqual({ day: 3, part: "夜" });
  });

  it("言い回しは4つの区分へ寄せる", () => {
    expect(parseRelativeTime("day+1 夕方")).toEqual({ day: 1, part: "夕" });
    expect(parseRelativeTime("day+1 深夜")).toEqual({ day: 1, part: "夜" });
    expect(parseRelativeTime("day+1 夜中")).toEqual({ day: 1, part: "夜" });
    expect(parseRelativeTime("day+1 早朝")).toEqual({ day: 1, part: "朝" });
  });

  it("全角の数字でも読む", () => {
    expect(parseRelativeTime("１４日目 夕")).toEqual({ day: 14, part: "夕" });
  });
});

describe("読めないものは null にする", () => {
  it("日数が書いていない言い回しは読まない", () => {
    expect(parseRelativeTime("翌日")).toBeNull();
  });

  it("区分だけでは、どの日か決められない", () => {
    expect(parseRelativeTime("夕方")).toBeNull();
  });

  it("空文字は読まない", () => {
    expect(parseRelativeTime("")).toBeNull();
  });

  it("裸の数字を日数と決めつけない", () => {
    expect(parseRelativeTime("14")).toBeNull();
    expect(parseRelativeTime("day")).toBeNull();
  });
});

describe("前後を比べる", () => {
  it("日が違えば日で決まる", () => {
    expect(
      compareRelativeTime({ day: 12, part: "夜" }, { day: 14, part: "朝" })
    ).toBe(-1);
  });

  it("同じ日なら区分で決まる", () => {
    expect(
      compareRelativeTime({ day: 3, part: "朝" }, { day: 3, part: "夜" })
    ).toBe(-1);
    expect(
      compareRelativeTime({ day: 3, part: "夕" }, { day: 3, part: "昼" })
    ).toBe(1);
  });

  /**
   * **これは「同時」ではなく「順序不明」である。**
   * `null` は朝より前でも夜より後でもない。
   */
  it("同じ日で区分が分からなければ、前後は決められない", () => {
    expect(
      compareRelativeTime({ day: 3, part: null }, { day: 3, part: "朝" })
    ).toBe(0);
    expect(isOrderUnknown({ day: 3, part: null }, { day: 3, part: "朝" })).toBe(
      true
    );
  });

  it("日が違えば、区分が分からなくても順序は読める", () => {
    expect(isOrderUnknown({ day: 3, part: null }, { day: 4, part: "朝" })).toBe(
      false
    );
  });
});

describe("作者に見せる形", () => {
  it("日と区分を並べる", () => {
    expect(formatRelativeTime({ day: 14, part: "夕" })).toBe("14日目 夕");
    expect(formatRelativeTime({ day: 14, part: null })).toBe("14日目");
  });

  it("起点より前は「◯日目」と書かない", () => {
    expect(formatRelativeTime({ day: -3, part: "朝" })).toBe("起点の3日前 朝");
    expect(formatRelativeTime({ day: 0, part: null })).toBe("起点の日");
  });
});
