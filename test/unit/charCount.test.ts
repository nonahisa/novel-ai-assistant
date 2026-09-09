import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  addCounts,
  countChars,
  countManuscriptLines,
  stripRuby,
  toManuscriptPages,
} from "../../src/core/charCount";
import {
  fromSiteNotation,
  stripRuby as rubyStripRuby,
} from "../../src/core/ruby";

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

/**
 * 傍点の印は本文ではない（実機確認リスト A-9 の代わり）。
 *
 * **2026-09-08に実機で見つけた不具合の再現。** `stripRuby` という同じ名前の
 * 関数が `charCount.ts` と `ruby.ts` の2つにあり、字数のほうは傍点 `{{強調}}` を
 * 知らなかった。本文へ傍点を1つ入れるたびに、作品の字数が **4字（`{{` と `}}`）
 * 水増しされて**いた（32,553字の作品で 32,559字と出た。正しくは 32,555字）。
 *
 * 定義を `core/ruby.ts` の1つに寄せ、ここでその結果を固定する。
 */
describe("ルビと傍点は字数に入れない", () => {
  test("傍点の印は数えず、囲まれた本文だけを数える", () => {
    const counts = countChars("{{強調}}");

    // 「強調」の2字。`{{` `}}` の4字は印であって本文ではない
    expect(counts.gross).toBe(2);
    expect(counts.net).toBe(2);
  });

  test("ルビは読み仮名を数えず、漢字だけを数える", () => {
    expect(countChars("{漢字|かんじ}").gross).toBe(2);
    expect(countChars("{漢字|かんじ}").net).toBe(2);
  });

  test("同じ文に傍点とルビが混ざっていても、印は全部落ちる", () => {
    // 「強調と漢字」の5字
    expect(countChars("{{強調}}と{漢字|かんじ}").gross).toBe(5);
  });

  test("外すのをやめれば、印まで数える（設定の切り替えが効いている）", () => {
    // excludeRuby を false にすると素の文字列そのままになる
    // 「{{強調}}」は6字、「{漢字|かんじ}」は8字（印まで数えた形）
    expect(countChars("{{強調}}", false).gross).toBe(6);
    expect(countChars("{漢字|かんじ}", false).gross).toBe(8);
  });

  test("原稿用紙の行数でも、傍点の印はマスを取らない", () => {
    // 印まで数えると 8字。落とせば2字で、どちらも1行に収まるので
    // 20字ぎりぎりの行で確かめる（印を数えると2行に増える）
    const line = "{{強調}}" + "あ".repeat(18);

    expect(countManuscriptLines(line)).toBe(1);
    expect(countManuscriptLines(line, false)).toBe(2);
  });

  /**
   * **投稿サイトの記法は、取り込んでから数える**（設計書6.12.4）。
   *
   * `｜漢字《かんじ》` のままでは落とさない。落としてよいのは
   * Markdown（`.md`）に取り込んだあとで、`.txt` はサイトの記法をそのまま
   * 持っていることがあり、`《》` を会話の括弧に使う作品と見分けられない。
   * そのため `countEpisodeChars` は `.txt` ではルビを外さない。
   */
  test("投稿サイトの記法は、取り込めば内部記法と同じ字数になる", () => {
    expect(countChars(fromSiteNotation("｜漢字《かんじ》")).gross).toBe(2);
    expect(countChars(fromSiteNotation("漢字《かんじ》")).gross).toBe(2);
    expect(countChars(fromSiteNotation("《《強調》》")).gross).toBe(2);
    expect(countChars(fromSiteNotation("｜強調《・・》")).gross).toBe(2);
  });

  test("取り込む前の投稿サイト記法は、そのまま数える", () => {
    // ここを勝手に落とすと、`《》` を括弧として使っている本文が減る
    expect(countChars("｜漢字《かんじ》").gross).toBe(8);
    expect(countChars("《《強調》》").gross).toBe(6);
  });
});

/**
 * 数え方の定義は1つだけにする（実機確認リスト A-9 の代わり）。
 *
 * **写しは片方だけが直る日が来る。** 実際、傍点を知らない写しのほうを
 * 字数が呼んでいた。`charCount.ts` は `ruby.ts` のものを読み、
 * 自分では持たない。
 */
describe("stripRuby の定義は1つ", () => {
  const charCountSource = readFileSync("src/core/charCount.ts", "utf8");

  test("charCount.ts は ruby.ts のものを読んでいる", () => {
    expect(charCountSource).toContain('import { stripRuby } from "./ruby";');
  });

  test("charCount.ts に写しの定義が戻っていない", () => {
    expect(charCountSource).not.toMatch(/function stripRuby/);
  });

  test("実体を持つのは ruby.ts だけ", () => {
    const owners = readdirSync("src/core")
      .filter((name) => name.endsWith(".ts"))
      .filter((name) =>
        /function stripRuby/.test(readFileSync("src/core/" + name, "utf8"))
      );

    expect(owners).toEqual(["ruby.ts"]);
  });

  test("同じ関数が返る（再輸出であって、作り直しではない）", () => {
    expect(stripRuby).toBe(rubyStripRuby);
  });
});
