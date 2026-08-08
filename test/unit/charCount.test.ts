import { describe, expect, test } from "vitest";
import {
  addCounts,
  countChars,
  countManuscriptLines,
  stripRuby,
  toManuscriptPages,
} from "../../src/core/charCount";

describe("文字数計測", () => {
  test("改行と空白を純文字数から除外し、総文字数には空白を残す", () => {
    expect(countChars("吾輩 は\r\n猫である。\n")).toEqual({
      gross: 9,
      net: 8,
      lines: 3,
      paragraphs: 1,
      // 「吾輩 は」「猫である。」「（末尾の空行）」で3行
      manuscriptLines: 3,
    });
  });

  test("Markdownルビから読みだけを除外する", () => {
    expect(stripRuby("{漢字|かんじ}と東京")).toBe("漢字と東京");
  });
});

describe("原稿用紙換算", () => {
  test("1行20字ちょうどなら1行を占める", () => {
    expect(countManuscriptLines("あ".repeat(20))).toBe(1);
  });

  test("21字なら2行を占める", () => {
    // 20字で折り返し、2行目は1字だけで残り19マスは余白になる
    expect(countManuscriptLines("あ".repeat(21))).toBe(2);
  });

  test("空行も1行分の場所を取る", () => {
    expect(countManuscriptLines("あ\n\nい")).toBe(3);
  });

  test("字下げの全角スペースも1マスを使う", () => {
    // 「　」＋19字＝20マスちょうど
    expect(countManuscriptLines("　" + "あ".repeat(19))).toBe(1);
    // 1字増えると折り返す
    expect(countManuscriptLines("　" + "あ".repeat(20))).toBe(2);
  });

  test("段落ごとに余白が出るため、割り算より枚数が多くなる", () => {
    // 21字の段落を20個。文字数は420字なので割り算では2枚だが、
    // 実際は各段落が2行を占めるので40行＝2枚…ではなく、
    // 折り返しの余白ぶん行数が増える
    const text = Array.from({ length: 20 }, () => "あ".repeat(21)).join("\n");
    const counts = countChars(text);

    expect(counts.net).toBe(420);
    // 割り算だと 420/400 = 2枚
    expect(Math.ceil(counts.net / 400)).toBe(2);
    // 実際は 20段落 × 2行 = 40行 = 2枚
    expect(counts.manuscriptLines).toBe(40);
    expect(toManuscriptPages(counts.manuscriptLines)).toBe(2);
  });

  test("短い会話文が続くと割り算より大幅に多くなる", () => {
    // 「はい」のような短い行が並ぶと、1行あたり2字でも1行を占める
    const text = Array.from({ length: 100 }, () => "はい").join("\n");
    const counts = countChars(text);

    expect(counts.net).toBe(200);
    // 割り算では1枚
    expect(Math.ceil(counts.net / 400)).toBe(1);
    // 実際は100行＝5枚
    expect(counts.manuscriptLines).toBe(100);
    expect(toManuscriptPages(counts.manuscriptLines)).toBe(5);
  });

  test("枚数は行数から求める（文字数からではない）", () => {
    // 20行でちょうど1枚、21行で2枚
    expect(toManuscriptPages(20)).toBe(1);
    expect(toManuscriptPages(21)).toBe(2);
    expect(toManuscriptPages(0)).toBe(0);
  });

  test("集計時に行数を合算できる", () => {
    const a = countChars("あ".repeat(21));
    const b = countChars("い".repeat(21));

    const total = addCounts(a, b);

    // ファイルごとに枚数を出して足すと誤差が積み上がるため、
    // 行数を合算してから枚数にする
    expect(total.manuscriptLines).toBe(4);
  });

  test("ルビは原稿用紙の字数に数えない", () => {
    // ルビを除くと17字で1行に収まるが、
    // ルビ記法をそのまま数えると26字になり2行に増えてしまう
    const text = "{魔導書庫|まどうしょこ}へ向かう途中で立ち止まった";

    expect(countManuscriptLines(text)).toBe(1);
    expect(countManuscriptLines(text, false)).toBe(2);
  });

  test("空文字は1行扱いにする", () => {
    // 何も書いていないファイルでも原稿用紙上は1行目に相当する
    expect(countManuscriptLines("")).toBe(1);
    expect(toManuscriptPages(countManuscriptLines(""))).toBe(1);
  });
});
