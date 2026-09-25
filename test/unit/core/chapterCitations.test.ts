import { describe, expect, test } from "vitest";
import {
  citedChapters,
  knownChaptersOf,
  unknownCitedChapters,
} from "../../../src/core/chapterCitations";

/**
 * 「AIで再読込」の提案が挙げる話数を、作品に実在するかで確かめる
 * （2026-09-25 精査 F5）。
 *
 * 作者の実機（2026-09-15）：2話ぶんしかない確認用の作品で、gemma4:12b が
 * 「第17話を根拠に文佳の祖母」と返した。**無い話を根拠にした提案**は、
 * 作者が選べば設定資料にそのまま載る。
 */

describe("値の中の話数を読む", () => {
  test("算用数字・全角・漢数字", () => {
    expect(citedChapters("文佳の祖母（第17話）")).toEqual([17]);
    expect(citedChapters("第１７話で判明")).toEqual([17]);
    expect(citedChapters("第十七話で判明")).toEqual([17]);
    expect(citedChapters("第二十話から課長")).toEqual([20]);
    expect(citedChapters("第百二話")).toEqual([102]);
  });

  test("範囲と列挙は、書かれた数を全部拾う", () => {
    expect(citedChapters("黒髪（第1〜3話）→ 銀髪（第7話）")).toEqual([1, 3, 7]);
    expect(citedChapters("第2・5話に登場")).toEqual([2, 5]);
    expect(citedChapters("第2、第5話に登場")).toEqual([2, 5]);
  });

  test("「第」の無い「3話から」も拾う（漢数字は「第」があるときだけ）", () => {
    expect(citedChapters("（3話から）霊能者")).toEqual([3]);
    // 「一話完結」は話数の名指しではない
    expect(citedChapters("一話完結の脇役")).toEqual([]);
  });

  test("話数の無い値は空", () => {
    expect(citedChapters("プロの霊能者。太志を保護する。")).toEqual([]);
  });
});

describe("作品に無い話を挙げていないか", () => {
  test("2話しかない作品で第17話を挙げたら、17を返す（作者の実機の形）", () => {
    const known = new Set([1, 2]);
    expect(unknownCitedChapters("文佳の祖母（第17話）", known)).toEqual([17]);
    expect(unknownCitedChapters("霊媒師（第2話から）", known)).toEqual([]);
  });

  test("話数の分かる話が1つも無い作品では、確かめない（判断できない）", () => {
    expect(unknownCitedChapters("第17話で判明", new Set())).toEqual([]);
  });
});

describe("作品の話数を集める", () => {
  test("合本は範囲の中の話を全部数える。本編以外は数えない", () => {
    const known = knownChaptersOf([
      { kind: "本編", chapterStart: 1, chapterEnd: 1 },
      { kind: "本編", chapterStart: 3, chapterEnd: 5 },
      { kind: "プロローグ", chapterStart: null, chapterEnd: null },
      { kind: "不明", chapterStart: 8, chapterEnd: null },
    ]);
    expect([...known].sort((a, b) => a - b)).toEqual([1, 3, 4, 5, 8]);
  });
});
