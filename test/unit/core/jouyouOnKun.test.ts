import { describe, expect, test } from "vitest";
import { jouyouKanjiList } from "../../src/core/jouyouKanji";
import {
  hasNoKunReading,
  jouyouOnKunSize,
  jouyouReadingCounts,
  readingsOf,
} from "../../src/core/jouyouOnKun";

/**
 * 常用漢字表の音訓の写し（`src/core/jouyouOnKun.ts`）。
 *
 * **4,388件を手で写せば必ず間違える。** 文化庁のPDFから機械で取り出したが、
 * 取り出し方そのものが間違っている可能性は残る。ここで見るのは、
 * **脱落と二重登録が無いこと**である。
 *
 * 字の取り違え（「亜」の読みに「哀」の読みが入る類）は、数を数えても
 * 見つけられない。怪しい判定を見つけたら、告示の表と突き合わせて直すこと
 * （`jouyouKanji.ts` の字種の表と同じ約束）。
 */
describe("音訓の写しに、脱落と二重登録が無い", () => {
  test("字の集合が、字種の表（2,136字）とぴったり一致する", () => {
    // **どちらかにしか無い字があれば、写し損ねか写しすぎである**
    const listed = jouyouKanjiList();
    expect(jouyouOnKunSize()).toBe(listed.length);

    const missing = listed.filter((char) => readingsOf(char) === undefined);
    expect(missing).toEqual([]);
  });

  test("読みが1つも無い字は、表には無い", () => {
    // 表のどの字にも、音か訓が必ず1つはある
    const empty = jouyouKanjiList().filter((char) => {
      const readings = readingsOf(char);
      return readings !== undefined && readings.on.length + readings.kun.length === 0;
    });
    expect(empty).toEqual([]);
  });

  test("**音2,352・訓2,036・合計4,388**（告示が公表している数）", () => {
    // 数が合えば、脱落も二重登録も無いと言える。
    // **取り違えまでは分からない**（上のコメントのとおり）
    const counts = jouyouReadingCounts();
    expect(counts).toEqual({ on: 2352, kun: 2036 });
    expect(counts.on + counts.kun).toBe(4388);
  });
});

describe("読みを引く", () => {
  test("**「然」の読みは「ゼン」「ネン」だけで、訓は無い**", () => {
    // 作者の指摘（2026-09-12）。だから「然し（しかし）」は表外の用法である
    expect(readingsOf("然")).toEqual({ on: ["ゼン", "ネン"], kun: [] });
  });

  test("訓の多い字も、送り仮名を含んだ形で全部持つ", () => {
    expect(readingsOf("生")).toEqual({
      on: ["セイ", "ショウ"],
      kun: [
        "いきる",
        "いかす",
        "いける",
        "うまれる",
        "うむ",
        "おう",
        "はえる",
        "はやす",
        "き",
        "なま",
      ],
    });
  });

  test("訓しか無い字もある", () => {
    expect(readingsOf("謎")).toEqual({ on: [], kun: ["なぞ"] });
  });

  test("**𠮟（U+20B9F）も引ける**", () => {
    // PDFの埋め込みフォントが持っておらず、抽出すると化けるので手で足した字。
    // サロゲートペアなので、字を1文字ずつ割るときは符号位置で割ること
    expect(readingsOf("\u{20b9f}")).toEqual({ on: ["シツ"], kun: ["しかる"] });
  });

  test("表に無い字は undefined", () => {
    // 「殆」「兎」は表外字。読みが無いのではなく、表に載っていない
    expect(readingsOf("殆")).toBeUndefined();
    expect(readingsOf("兎")).toBeUndefined();
  });
});

describe("訓を持たない字を見分ける（hasNoKunReading）", () => {
  test("音読みでしか使わない字は true", () => {
    // ここに送り仮名が付いていたら、それは表外の訓である
    for (const char of ["然", "尚", "宜", "随", "暫", "漸"]) {
      expect(hasNoKunReading(char), char).toBe(true);
    }
  });

  test("訓を持つ字は false", () => {
    for (const char of ["生", "下", "人", "謎"]) {
      expect(hasNoKunReading(char), char).toBe(false);
    }
  });

  test("**表に無い字も false**", () => {
    // 「訓を持たない」と「表に載っていない」は別のこと。
    // 混ぜると、呼び出し側が表外字を「表の中の音読み字」と読み違える
    expect(hasNoKunReading("殆")).toBe(false);
    expect(hasNoKunReading("あ")).toBe(false);
  });
});
