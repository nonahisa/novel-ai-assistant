import { describe, expect, test } from "vitest";
import { countChars } from "../../../src/core/charCount";
import {
  countLyricsUnits,
  countMangaUnits,
  measureKindCounts,
  measureKindText,
} from "../../../src/core/kindMeasure";

/**
 * 種類ごとの数え方の目安（設計書6.109 ②）。
 *
 * **字数そのものは変えない。** 目安は字数の横に添えるだけで、小説には
 * 何も添えない（これまでの画面のまま）。
 */

function measure(kind: Parameters<typeof measureKindText>[0], text: string) {
  return measureKindText(kind, text, countChars(text));
}

describe("小説", () => {
  test("目安を添えない", () => {
    expect(measure("novel", "本文。")).toBeUndefined();
    expect(measure(undefined, "本文。")).toBeUndefined();
    expect(measureKindCounts("novel", countChars("本文。"))).toBeUndefined();
  });
});

describe("台本（400字詰め1枚＝約1分）", () => {
  test("枚数と分数が同じ数になる", () => {
    // 20字×20行＝1枚。21行あれば2枚目に入る
    const text = Array.from({ length: 21 }, () => "太郎「行こう」").join("\n");
    const result = measure("script", text);
    expect(result?.short).toBe("約2分");
    expect(result?.detail).toContain("400字詰め 約2枚");
    expect(result?.detail).toContain("約2分");
  });

  test("字数を400で割らない（折り返しの余白も数える）", () => {
    // 21字の行は2行を占める。10行で20行＝1枚ちょうど
    const text = Array.from({ length: 10 }, () => "あ".repeat(21)).join("\n");
    expect(measure("script", text)?.short).toBe("約1分");
    // 11行なら22行＝2枚（字数は231字で、割り算なら1枚になる）
    const more = Array.from({ length: 11 }, () => "あ".repeat(21)).join("\n");
    expect(measure("script", more)?.short).toBe("約2分");
  });

  test("作品の合計（字数の集計）からも出せる", () => {
    const counts = countChars(Array.from({ length: 40 }, () => "○駅前").join("\n"));
    expect(measureKindCounts("script", counts)?.short).toBe("約2分");
  });
});

describe("エッセイ・記事（1分＝約500字）", () => {
  test("読み終えるまでの分数を切り上げで出す", () => {
    expect(measure("essay", "あ".repeat(500))?.short).toBe("読了 約1分");
    expect(measure("essay", "あ".repeat(501))?.short).toBe("読了 約2分");
  });

  test("空白は数えない（純文字数で測る）", () => {
    expect(measure("essay", "　".repeat(600) + "あ")?.short).toBe("読了 約1分");
  });
});

describe("漫画の原作（■ページ・□コマ）", () => {
  const text = [
    "■1ページ",
    "□コマ1",
    "　教室の全景",
    "太郎「おはよう」",
    "□コマ2",
    "■2ページ",
    "□コマ1",
  ].join("\n");

  test("行頭の■をページ、□をコマとして数える", () => {
    expect(countMangaUnits(text)).toEqual({ pages: 2, panels: 3 });
    expect(measure("manga", text)?.short).toBe("2ページ・3コマ");
  });

  test("行の途中の■□は数えない", () => {
    expect(countMangaUnits("太郎「□□って何？」")).toEqual({ pages: 0, panels: 0 });
  });

  test("付箋（シーンメモ）の行は数えない", () => {
    expect(countMangaUnits("// ■ここは後で")).toEqual({ pages: 0, panels: 0 });
  });
});

describe("歌詞・詩（【】の札と空行で区切った塊が1連）", () => {
  test("札は行にも連にも数えない", () => {
    const text = [
      "【Aメロ】",
      "一行目",
      "二行目",
      "",
      "三行目",
      "【サビ】",
      "四行目",
    ].join("\n");
    expect(countLyricsUnits(text)).toEqual({ stanzas: 3, lines: 4 });
    expect(measure("lyrics", text)?.short).toBe("3連・4行");
  });

  test("空行が続いても連は増えない", () => {
    expect(countLyricsUnits("一\n\n\n\n二")).toEqual({ stanzas: 2, lines: 2 });
  });

  test("字数の集計だけからは出さない（中身を見ないと数えられない）", () => {
    expect(measureKindCounts("lyrics", countChars("一\n二"))).toBeUndefined();
    expect(measureKindCounts("manga", countChars("■1"))).toBeUndefined();
  });
});
