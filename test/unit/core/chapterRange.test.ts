import { describe, expect, test } from "vitest";
import {
  appearedInRange,
  chapterRangeBounds,
  chapterRangeText,
  chaptersInRange,
  isFullChapterRange,
  normalizeChapterRange,
  parseChapterRangeInput,
  spanOverlapsRange,
} from "../../../src/core/chapterRange";

/**
 * 話数の範囲（第M〜N話）の部品（設計書6.38.2「第M〜N話の相関図」）。
 *
 * 相関図・設定資料の書き出し・年表・呼び合いの一覧の4つが同じ判断を使う。
 * 端・入れ替え・話数の無いもの・1話だけの作品をここで固める。
 */

describe("つまみの値を範囲へ直す", () => {
  test("開いたときの位置（第1話〜最終話）は、両端とも「端まで」になる", () => {
    expect(normalizeChapterRange(1, 19, 19)).toEqual({ from: null, to: null });
    expect(normalizeChapterRange(undefined, undefined, 19)).toEqual({
      from: null,
      to: null,
    });
  });

  test("M＞N は入れ替える", () => {
    expect(normalizeChapterRange(8, 3, 19)).toEqual({ from: 3, to: 8 });
  });

  test("1〜最終話の外は端へ寄せる", () => {
    expect(normalizeChapterRange(0, 40, 19)).toEqual({ from: null, to: null });
    expect(normalizeChapterRange(-3, 5, 19)).toEqual({ from: null, to: 5 });
    expect(normalizeChapterRange(25, 30, 19)).toEqual({ from: 19, to: null });
  });

  test("同じ話を両方に置けば、その1話だけになる", () => {
    expect(normalizeChapterRange(5, 5, 19)).toEqual({ from: 5, to: 5 });
  });

  test("最終話が1話だけの作品では、いつも絞らない", () => {
    expect(normalizeChapterRange(1, 1, 1)).toEqual({ from: null, to: null });
    expect(normalizeChapterRange(3, 7, 1)).toEqual({ from: null, to: null });
  });

  test("話数の記録が無い作品（最終話0）では絞らない", () => {
    expect(normalizeChapterRange(2, 5, 0)).toEqual({ from: null, to: null });
  });

  test("数でない値は端として読む", () => {
    expect(normalizeChapterRange(Number.NaN, 4, 10)).toEqual({ from: null, to: 4 });
    expect(normalizeChapterRange(3, null, 10)).toEqual({ from: 3, to: null });
  });

  test("絞っていないかを判定する", () => {
    expect(isFullChapterRange({ from: null, to: null })).toBe(true);
    expect(isFullChapterRange({ from: 2, to: null })).toBe(false);
  });

  test("つまみに置く数字は、端を話数にして返す", () => {
    expect(chapterRangeBounds({ from: null, to: null }, 19)).toEqual({
      from: 1,
      to: 19,
    });
    expect(chapterRangeBounds({ from: 3, to: 8 }, 19)).toEqual({ from: 3, to: 8 });
    // 話数の記録が無い作品でも数字は1以上（つまみは押せなくする）
    expect(chapterRangeBounds({ from: null, to: null }, 0)).toEqual({
      from: 1,
      to: 1,
    });
  });
});

describe("範囲に出てきたか", () => {
  test("どこか1話でも範囲に入れば出てきた", () => {
    expect(appearedInRange([1, 9], { from: 3, to: 8 })).toBe(false);
    expect(appearedInRange([1, 5, 9], { from: 3, to: 8 })).toBe(true);
  });

  test("両端を含む", () => {
    expect(appearedInRange([3], { from: 3, to: 8 })).toBe(true);
    expect(appearedInRange([8], { from: 3, to: 8 })).toBe(true);
    expect(appearedInRange([2], { from: 3, to: 8 })).toBe(false);
    expect(appearedInRange([9], { from: 3, to: 8 })).toBe(false);
  });

  test("話数の記録が無いものは落とさない", () => {
    expect(appearedInRange([], { from: 3, to: 8 })).toBe(true);
    expect(appearedInRange([Number.NaN], { from: 3, to: 8 })).toBe(true);
  });

  test("下端が無ければ「第N話までに初登場」と同じ", () => {
    expect(appearedInRange([4, 9], { from: null, to: 5 })).toBe(true);
    expect(appearedInRange([6, 9], { from: null, to: 5 })).toBe(false);
  });

  test("範囲の中の話数だけを残す（丸の大きさ）", () => {
    expect(chaptersInRange([1, 3, 5, 8, 9], { from: 3, to: 8 })).toEqual([3, 5, 8]);
    expect(chaptersInRange([1, 2], { from: null, to: null })).toEqual([1, 2]);
  });
});

describe("話（合本の幅）と範囲が重なるか", () => {
  test("1話の行", () => {
    expect(spanOverlapsRange(5, 5, { from: 3, to: 8 })).toBe(true);
    expect(spanOverlapsRange(2, 2, { from: 3, to: 8 })).toBe(false);
    expect(spanOverlapsRange(9, null, { from: 3, to: 8 })).toBe(false);
  });

  test("合本は幅のどこかが重なれば残す", () => {
    expect(spanOverlapsRange(1, 3, { from: 3, to: 8 })).toBe(true);
    expect(spanOverlapsRange(8, 12, { from: 3, to: 8 })).toBe(true);
    expect(spanOverlapsRange(1, 2, { from: 3, to: 8 })).toBe(false);
  });

  test("話数の読めない行は残す", () => {
    expect(spanOverlapsRange(null, null, { from: 3, to: 8 })).toBe(true);
  });
});

describe("範囲の数字", () => {
  test("第M話〜第N話。1話だけなら第M話", () => {
    expect(chapterRangeText(1, 19)).toBe("第1話〜第19話");
    expect(chapterRangeText(4, 4)).toBe("第4話");
  });
});

describe("入力欄の範囲を読む（設定資料の書き出し）", () => {
  test("いろいろな区切りを受ける", () => {
    expect(parseChapterRangeInput("3〜8")).toEqual({ from: 3, to: 8 });
    expect(parseChapterRangeInput("3-8")).toEqual({ from: 3, to: 8 });
    expect(parseChapterRangeInput(" 3 ~ 8 ")).toEqual({ from: 3, to: 8 });
    expect(parseChapterRangeInput("３－８")).toEqual({ from: 3, to: 8 });
  });

  test("数字1つなら第1話からその話まで（今までの「第N話まで」）", () => {
    expect(parseChapterRangeInput("12")).toEqual({ from: 1, to: 12 });
  });

  test("M＞N は入れ替える", () => {
    expect(parseChapterRangeInput("8〜3")).toEqual({ from: 3, to: 8 });
  });

  test("読めないものは undefined", () => {
    expect(parseChapterRangeInput("")).toBeUndefined();
    expect(parseChapterRangeInput("0")).toBeUndefined();
    expect(parseChapterRangeInput("a〜3")).toBeUndefined();
    expect(parseChapterRangeInput("1〜2〜3")).toBeUndefined();
    expect(parseChapterRangeInput("1.5")).toBeUndefined();
    expect(parseChapterRangeInput("〜3")).toBeUndefined();
  });
});
