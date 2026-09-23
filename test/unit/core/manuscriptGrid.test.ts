import { describe, expect, test } from "vitest";
import {
  breakIntoLines,
  gridGeometry,
  layoutGrid,
  lineWidth,
  unitsOfLine,
  type GridLine,
  type GridOptions,
  type GridUnit,
} from "../../../src/core/manuscriptGrid";

/**
 * 公募の納品用の組版（設計書6.33.5 の3）。
 *
 * **1ページの行数と1行の字数を、指定どおりに収める。** CSS だけでは
 * 揃わない（約物・ルビ・縦中横で字の幅が変わる）ので、行はコードで割る。
 * ここで見るのは、その行割り・禁則・ページ割り・寸法である。
 */

const V40: GridOptions = { columns: 40, rows: 40, hanging: true, vertical: true };

function opts(columns: number, hanging = true, vertical = true): GridOptions {
  return { columns, rows: 20, hanging, vertical };
}

/** 1行を部品にして、指定の字数で割る */
function lines(text: string, options: GridOptions): GridLine[] {
  return breakIntoLines(unitsOfLine(text, "curly", options.vertical), options);
}

/** 行の中身を文字列で（ルビは親文字、ぶら下げは「|」のあと） */
function show(line: GridLine): string {
  const body = line.units.map((unit) => unit.text).join("");
  return line.hang ? `${body}|${line.hang.text}` : body;
}

function allText(result: GridLine[]): string {
  return result.map((line) => line.units.map((u) => u.text).join("") + (line.hang?.text ?? "")).join("");
}

describe("字数どおりに行を割る", () => {
  test("20字ずつに割れる", () => {
    const text = "あ".repeat(45);
    const result = lines(text, opts(20));

    expect(result.map((line) => lineWidth(line))).toEqual([20, 20, 5]);
  });

  test("字を落とさない・足さない", () => {
    const text = "　朝の駅は、まだ眠っているようだった。「待って」と言いかけて、僕は口を閉じた。".repeat(7);
    const result = lines(text, opts(20));

    expect(allText(result)).toBe(text);
  });

  test("どの行も指定の字数を超えない（ぶら下げは枠の外に出る1字だけ）", () => {
    const text = "「ねえ、覚えてる？」。「うん」、と彼女は言った。……そっと傘を開く。".repeat(30);
    for (const columns of [20, 40]) {
      for (const hanging of [true, false]) {
        for (const line of lines(text, opts(columns, hanging))) {
          expect(lineWidth(line)).toBeLessThanOrEqual(columns);
          if (!hanging) expect(line.hang).toBeUndefined();
        }
      }
    }
  });

  test("空の段落は、空の1行になる", () => {
    expect(lines("", opts(20))).toEqual([{ units: [] }]);
  });
});

describe("禁則", () => {
  const nineteen = "あ".repeat(19);

  test("行頭に句読点が来るとき、ぶら下げありなら行末の外へ出す", () => {
    const result = lines(`${nineteen}い。う`, opts(20, true));

    expect(show(result[0])).toBe(`${nineteen}い|。`);
    expect(show(result[1])).toBe("う");
  });

  test("ぶら下げなしなら、前の字ごと次の行へ送る（追い出し）", () => {
    const result = lines(`${nineteen}い。う`, opts(20, false));

    expect(show(result[0])).toBe(nineteen);
    expect(show(result[1])).toBe("い。う");
  });

  test("閉じ括弧はぶら下げず、前の字ごと送る", () => {
    const result = lines(`${nineteen}い」う`, opts(20, true));

    expect(show(result[0])).toBe(nineteen);
    expect(show(result[1])).toBe("い」う");
  });

  test("「。」」のように句読点の後ろに閉じ括弧が続くときは、ぶら下げずに送る", () => {
    // 「。」をぶら下げると、次の行が「」」から始まってしまう
    const result = lines(`${nineteen}い。」う`, opts(20, true));

    expect(show(result[0])).toBe(nineteen);
    expect(show(result[1])).toBe("い。」う");
  });

  test("閉じ括弧の連続は、続くぶんだけさかのぼる", () => {
    const result = lines(`${"あ".repeat(18)}いう」』え`, opts(20, false));

    // 「」」も「』」も行頭に置けないので、その前の「う」ごと次の行へ送る
    expect(show(result[0])).toBe(`${"あ".repeat(18)}い`);
    expect(show(result[1])).toBe("う」』え");
  });

  test("行末に開き括弧が来るときは、括弧を次の行へ送る", () => {
    const result = lines(`${nineteen}「いう」`, opts(20, true));

    expect(show(result[0])).toBe(nineteen);
    expect(show(result[1])).toBe("「いう」");
  });

  test("小さい仮名と長音は行頭に来てよい（原稿用紙の書き方）", () => {
    const result = lines(`${"あ".repeat(20)}っー`, opts(20, true));

    expect(show(result[0])).toBe("あ".repeat(20));
    expect(show(result[1])).toBe("っー");
  });

  test("直しきれない並びは、禁則を破っても先へ進む（止まらない）", () => {
    const text = "」".repeat(50);
    const result = lines(text, opts(20, false));

    expect(allText(result)).toBe(text);
    for (const line of result) expect(lineWidth(line)).toBeLessThanOrEqual(20);
  });
});

describe("ルビのかたまり", () => {
  test("ルビは親文字の数だけマスを取り、途中で割らない", () => {
    // 19字のあとに3字のルビ → 丸ごと次の行へ
    const result = lines(`${"あ".repeat(19)}{改札口|かいさつぐち}です`, opts(20));

    expect(show(result[0])).toBe("あ".repeat(19));
    expect(result[1].units[0]).toMatchObject({ kind: "ruby", text: "改札口", reading: "かいさつぐち", width: 3 });
  });

  test("ルビの後ろの句読点も、ぶら下げの禁則が効く", () => {
    const result = lines(`${"あ".repeat(17)}{改札|かいさつ}い。`, opts(20, false));

    expect(lineWidth(result[0])).toBe(19);
    expect(show(result[1])).toBe("い。");
  });

  test("1行より長いルビは、行の長さで割り、読みも割り振る", () => {
    const result = lines("{寿限無寿限無五劫|じゅげむじゅげむごこう}", opts(4));

    expect(result.map((line) => lineWidth(line))).toEqual([4, 4]);
    const readings = result.map((line) => (line.units[0] as GridUnit).reading ?? "");
    expect(readings.join("")).toBe("じゅげむじゅげむごこう");
    expect(allText(result)).toBe("寿限無寿限無五劫");
  });

  test("傍点の字は1字ずつマスを取り、印が付く", () => {
    const units = unitsOfLine("それは{{大事}}だ", "curly", true);

    expect(units.filter((unit) => unit.emphasis).map((unit) => unit.text)).toEqual(["大", "事"]);
  });
});

describe("半角の字", () => {
  test("縦書き：1〜2字の半角英数字は縦中横で1マス", () => {
    const units = unitsOfLine("3月12日", "curly", true);

    expect(units.map((unit) => [unit.kind, unit.text])).toEqual([
      ["tcy", "3"],
      ["char", "月"],
      ["tcy", "12"],
      ["char", "日"],
    ]);
  });

  test("縦書き：3字以上の半角は1字1マスで立てる", () => {
    const units = unitsOfLine("2026年", "curly", true);

    expect(units.map((unit) => [unit.kind, unit.text])).toEqual([
      ["half", "2"],
      ["half", "0"],
      ["half", "2"],
      ["half", "6"],
      ["char", "年"],
    ]);
  });

  test("横書き：半角は2字で1マス", () => {
    const units = unitsOfLine("ABCは", "curly", false);

    expect(units.map((unit) => [unit.kind, unit.text])).toEqual([
      ["half", "AB"],
      ["half", "C"],
      ["char", "は"],
    ]);
  });

  test("サロゲートペアの字は1字1マス", () => {
    const units = unitsOfLine("𠮷野家", "curly", true);

    expect(units.map((unit) => unit.text)).toEqual(["𠮷", "野", "家"]);
  });
});

describe("ページに割る", () => {
  const body = "　あいうえおかきくけこさしすせそたちつてとなにぬねの。".repeat(80);

  test.each([
    [40, 40],
    [40, 30],
    [20, 20],
  ])("%d字×%d行：どのページも行数と字数が指定に収まる", (columns, rows) => {
    const options: GridOptions = { columns, rows, hanging: true, vertical: true };
    const pages = layoutGrid([{ heading: "第1話", body, notation: "curly" }], options);

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.lines.length).toBeLessThanOrEqual(rows);
      for (const line of page.lines) expect(lineWidth(line)).toBeLessThanOrEqual(columns);
    }
    // 最後のページ以外は、行で埋まっている
    for (const page of pages.slice(0, -1)) expect(page.lines.length).toBe(rows);
  });

  test("話の頭は新しいページから。見出しの1行と空き1行のあとに本文", () => {
    const pages = layoutGrid(
      [
        { heading: "第1話　駅", body: "　一。", notation: "curly" },
        { heading: "第2話　雨", body: "　二。", notation: "curly" },
      ],
      V40
    );

    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.heading)).toEqual(["第1話　駅", "第2話　雨"]);
    expect(pages[0].lines.map(show)).toEqual(["第1話　駅", "", "　一。"]);
  });

  test("本文の頭と終わりの空行は詰める。途中の空行は1行ずつ残す（場面の切れ目）", () => {
    const pages = layoutGrid(
      [{ heading: "", body: "\n\n　一。\n\n　二。\n\n", notation: "curly" }],
      V40
    );

    expect(pages[0].lines.map(show)).toEqual(["　一。", "", "　二。"]);
  });

  test("シーンメモは紙に出さない", () => {
    const pages = layoutGrid(
      [{ heading: "", body: "　一。\n// メモ：あとで直す\n　二。", notation: "curly" }],
      V40
    );
    const text = pages.flatMap((page) => page.lines.map(show)).join("\n");

    expect(text).not.toContain("メモ");
    expect(text).toContain("　二。");
  });
});

describe("寸法", () => {
  test.each([
    ["A4横置き・縦書き 40×40", 297, 210, { columns: 40, rows: 40, hanging: true, vertical: true }],
    ["A4横置き・縦書き 40×30", 297, 210, { columns: 40, rows: 30, hanging: true, vertical: true }],
    ["A4縦置き・縦書き 20×20", 210, 297, { columns: 20, rows: 20, hanging: true, vertical: true }],
    ["A4縦置き・横書き 40×40", 210, 297, { columns: 40, rows: 40, hanging: false, vertical: false }],
  ] as const)("%s：字数×マス・行数×行送りが本文の範囲に収まる", (_name, width, height, options) => {
    const margin = 20;
    const geometry = gridGeometry(width, height, margin, options);
    const inline = options.vertical ? height - margin * 2 : width - margin * 2;
    const block = options.vertical ? width - margin * 2 : height - margin * 2;

    expect(options.columns * geometry.cell).toBeLessThanOrEqual(inline + 0.001);
    expect(options.rows * geometry.pitch).toBeLessThanOrEqual(block + 0.001);
    // ルビが隣の行にかぶらない程度に行間を空ける
    expect(geometry.pitch).toBeGreaterThanOrEqual(geometry.cell * 1.5 - 0.01);
    // 行の長さのあまりは、両端に半分ずつ
    expect(geometry.inlineOffset * 2 + options.columns * geometry.cell).toBeCloseTo(inline, 1);
  });

  test("行が少なければ、字は行の長さいっぱいに大きくなる", () => {
    const geometry = gridGeometry(297, 210, 20, { columns: 20, rows: 20, hanging: true, vertical: true });

    expect(geometry.cell).toBeCloseTo(170 / 20, 1);
  });
});
