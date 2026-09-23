import { describe, expect, test } from "vitest";
import {
  PAGINATE_HELPERS,
  PRINT_PAGINATE_SCRIPT,
} from "../../../src/core/printPaginate";
import { NO_LINE_END, NO_LINE_START } from "../../../src/core/kinsoku";

/**
 * 印刷用HTMLを紙1枚ずつの面に割るスクリプト（設計書6.33.5 の1）。
 *
 * 面の割り方そのものは、ブラウザが字を組まないと決まらない（ここでは
 * 測れない）。単体テストで見るのは、**切れ目の禁則**と、スクリプトが
 * 文として壊れていないことだけである。実際に面へ割れることは、生成した
 * HTML をブラウザで開いて確かめる（報告に書く）。
 */

type CutForKinsoku = (texts: string[], cut: number) => number;

function cutForKinsoku(): CutForKinsoku {
  return new Function(`${PAGINATE_HELPERS}\nreturn cutForKinsoku;`)() as CutForKinsoku;
}

/** 文字列を1字ずつの部品に */
function atoms(text: string): string[] {
  return [...text];
}

describe("面の切れ目の禁則", () => {
  const cut = cutForKinsoku();

  test("禁則に触れなければ、そのまま切る", () => {
    expect(cut(atoms("あいうえお"), 3)).toBe(3);
  });

  test("次の面の頭が句読点なら、前の字ごと送る", () => {
    // 「あいう」で切ると次の面が「。」から始まる
    expect(cut(atoms("あいう。えお"), 3)).toBe(2);
  });

  test("閉じ括弧が続くなら、続くぶんだけさかのぼる", () => {
    // 「あい」「う。」」……「。」も「」」も行頭に置けない
    expect(cut(atoms("あいう。」えお"), 4)).toBe(2);
  });

  test("この面の終わりが開き括弧なら、括弧を次の面へ送る", () => {
    expect(cut(atoms("あいう「えお」"), 4)).toBe(3);
  });

  test("ルビのかたまりは1つの部品として扱う", () => {
    expect(cut(["あ", "漢字", "。", "い"], 2)).toBe(1);
  });

  test("ルビなどの札（文字を持たない部品）は禁則に触れない", () => {
    expect(cut(["あ", "", "い"], 1)).toBe(1);
  });

  test("4つより多くはさかのぼらない（面に大きな穴を空けない）", () => {
    // 合う切れ目は「ああ」の後ろ（6つさかのぼる）。そこまでは戻らず、元の数を返す
    const texts = atoms("ああ」」」」」」い");
    expect(cut(texts, 7)).toBe(7);
  });

  test("段落の頭より前へは戻らない", () => {
    expect(cut(atoms("「あ"), 1)).toBe(1);
  });

  test("切れ目が段落の外なら、そのまま返す", () => {
    expect(cut(atoms("あい"), 0)).toBe(0);
    expect(cut(atoms("あい"), 2)).toBe(2);
  });
});

describe("スクリプトの形", () => {
  test("文として読める（構文の誤りで面が1枚も出ない、を防ぐ）", () => {
    expect(() => new Function(PRINT_PAGINATE_SCRIPT)).not.toThrow();
  });

  test("禁則の字は kinsoku.ts のものが入る（写しを置かない）", () => {
    expect(PAGINATE_HELPERS).toContain(JSON.stringify(NO_LINE_START));
    expect(PAGINATE_HELPERS).toContain(JSON.stringify(NO_LINE_END));
  });

  test("面ができてから、印刷の余白を0にする", () => {
    // 失敗したときは流し込みの紙に戻る。余白を先に0にすると、紙の端まで字が来る
    const paginateAt = PRINT_PAGINATE_SCRIPT.indexOf("paginate();");
    const marginAt = PRINT_PAGINATE_SCRIPT.indexOf("@page { margin: 0; }");
    expect(paginateAt).toBeGreaterThan(0);
    expect(marginAt).toBeGreaterThan(paginateAt);
  });

  test("外のものを読み込まない", () => {
    expect(PRINT_PAGINATE_SCRIPT).not.toContain("http");
    expect(PRINT_PAGINATE_SCRIPT).not.toContain("import");
    expect(PRINT_PAGINATE_SCRIPT).not.toContain("fetch");
  });

  test("閉じタグの字を含まない（script 要素がそこで終わらない）", () => {
    expect(PRINT_PAGINATE_SCRIPT).not.toContain("</");
  });
});
