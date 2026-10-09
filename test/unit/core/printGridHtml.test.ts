import { describe, expect, test } from "vitest";
import {
  buildGridPrintHtml,
  describeGrid,
  GRID_HEADER_FOOTER,
  GRID_MARGIN_MM,
  GRID_MARGINS,
  gridFontSizePt,
  gridMarginClear,
  gridPaper,
  type GridPaper,
} from "../../../src/core/printGridHtml";
import { gridGeometry, layoutGrid, type GridOptions } from "../../../src/core/manuscriptGrid";
import { PRINT_PAGINATE_SCRIPT } from "../../../src/core/printPaginate";

/**
 * 公募の納品用の組版を、印刷用HTMLにする（設計書6.33.5 の3）。
 *
 * 行とページは `manuscriptGrid.ts` が決める。ここで見るのは、決まった
 * マスがそのまま面になること（面の数・行の数・マスの寸法）と、
 * 作者の本文が文字として出ること。
 */

const V40: GridOptions = { columns: 40, rows: 40, hanging: true, vertical: true };
const BODY = "　朝の駅は、まだ眠っているようだった。「{改札|かいさつ}の向こうで」と彼女は言った。3月5日。".repeat(40);

function grid(
  body = BODY,
  options: GridOptions = V40,
  paper: GridPaper = "a4-landscape"
): string {
  return buildGridPrintHtml({
    workTitle: "銀の航路",
    episodes: [{ heading: "第1話　夜の駅", body, notation: "curly" }],
    paper,
    grid: options,
  });
}

/** 扉を除いた面ごとの行の数 */
function linesPerPage(html: string): number[] {
  return html
    .split('<div class="page grid-page"')
    .slice(1)
    .map((page) => (page.match(/<div class="gl">/g) ?? []).length);
}

describe("マスがそのまま面になる", () => {
  test.each([
    [40, 40],
    [40, 30],
    [20, 20],
  ])("%d字×%d行：面の数と、面ごとの行の数が組版どおり", (columns, rows) => {
    const options: GridOptions = { columns, rows, hanging: true, vertical: true };
    const pages = layoutGrid([{ heading: "第1話　夜の駅", body: BODY, notation: "curly" }], options);
    const out = grid(BODY, options);

    expect(linesPerPage(out)).toEqual(pages.map((page) => page.lines.length));
    for (const count of linesPerPage(out)) expect(count).toBeLessThanOrEqual(rows);
    // 扉が1枚
    expect(out.match(/<div class="page page-cover">/g)).toHaveLength(1);
  });

  test("面は組み上がった形で渡し、スクリプトには割り直させない", () => {
    const out = grid();

    expect(out).toContain('data-grid="1"');
    expect(out).toContain(PRINT_PAGINATE_SCRIPT);
    expect(out).not.toContain('id="print-source"');
  });

  test("紙の余白はいつも0（面の中に余白を持つ）", () => {
    expect(grid()).toContain("@page { size: 297mm 210mm; margin: 0; }");
    expect(grid(BODY, V40, "a4-portrait")).toContain("@page { size: 210mm 297mm; margin: 0; }");
  });

  test("字の大きさと行送りは、寸法の計算どおり", () => {
    const geometry = gridGeometry(297, 210, GRID_MARGIN_MM, V40);
    const out = grid();

    expect(out).toContain(`font-size: ${geometry.cell}mm;`);
    expect(out).toContain(`block-size: ${geometry.pitch}mm;`);
    expect(out).toContain(`margin-inline-start: ${geometry.inlineOffset}mm;`);
  });

  test("面ごとに、その話の見出しを渡す（上下の余白の「話の見出し」）", () => {
    expect(grid()).toContain('<div class="page grid-page" data-heading="第1話　夜の駅">');
  });
});

describe("マスの中身", () => {
  test("ふつうの字は1字1マス", () => {
    expect(grid("あい")).toContain('<div class="gl"><i>あ</i><i>い</i></div>');
  });

  test("ルビは親文字のマスの上に読みを置く", () => {
    expect(grid("{改札|かいさつ}")).toContain(
      '<b><i>改</i><i>札</i><span class="rt">かいさつ</span></b>'
    );
  });

  test("縦中横・半角・傍点に印が付く", () => {
    const out = grid("3月2026年{{大事}}");

    expect(out).toContain('<i class="t">3</i>');
    expect(out).toContain('<i class="h">2</i>');
    expect(out).toContain('<i class="e">大</i>');
  });

  test("傍点はマスの外側に置き、圏点の指定は使わない（字がマスからずれる）", () => {
    const out = grid("{{大事}}");

    expect(out).toContain('.gl i.e::after { content: "\\FE45";');
    expect(out).not.toContain("text-emphasis");
  });

  test("ぶら下げた句読点は、行の最後のマスのあとに置く", () => {
    const options: GridOptions = { columns: 5, rows: 20, hanging: true, vertical: true };
    expect(grid("あいうえお。か", options)).toContain(
      '<div class="gl"><i>あ</i><i>い</i><i>う</i><i>え</i><i>お</i><i>。</i></div>'
    );
  });

  test("本文の記号は文字として出る", () => {
    const out = grid("<b>&");

    expect(out).toContain("&lt;");
    expect(out).toContain("&amp;");
    expect(out).not.toContain("<b>&");
  });

  test("作品名・見出しも逃がす", () => {
    const out = buildGridPrintHtml({
      workTitle: "<script>alert(1)</script>",
      episodes: [{ heading: '"><x>', body: "本文", notation: "curly" }],
      paper: "a4-landscape",
      grid: V40,
    });

    expect(out).not.toContain("<script>alert");
    expect(out).toContain('data-heading="&quot;&gt;&lt;x&gt;"');
    expect([...out.matchAll(/<script>/g)]).toHaveLength(1);
  });
});

describe("縦書きと横書き", () => {
  test("縦書きは面の中だけ縦に組み、半角を立てる", () => {
    const out = grid();

    expect(out).toContain(".page-body { writing-mode: vertical-rl; }");
    expect(out).toContain(".gl i.h { text-orientation: upright; }");
    expect(out).toContain('data-vertical="1"');
  });

  test("横書きには縦組みの指定が入らない", () => {
    const out = grid(BODY, { ...V40, vertical: false }, "a4-portrait");

    expect(out).not.toContain("writing-mode");
    expect(out).toContain('data-vertical="0"');
  });
});

describe("上下の余白と案内", () => {
  test("公募の既定は、上：なし／下：ページ番号", () => {
    expect(GRID_HEADER_FOOTER).toEqual({ top: "none", bottom: "page" });
    expect(grid()).toContain('data-head="none" data-foot="page"');
  });

  test("選んだものと作者名を渡す", () => {
    const out = buildGridPrintHtml({
      workTitle: "銀の航路",
      episodes: [{ heading: "第1話", body: "本文", notation: "curly" }],
      paper: "a4-landscape",
      grid: V40,
      headerFooter: { top: "author", bottom: "page" },
      author: "山田",
    });

    expect(out).toContain('data-head="author" data-foot="page"');
    expect(out).toContain('data-author="山田"');
  });

  test("案内帯に、字数×行数・向き・禁則・紙を出す", () => {
    const out = grid();

    expect(out).toContain('<div class="print-guide">');
    expect(out).toContain(describeGrid("a4-landscape", V40));
    expect(describeGrid("a4-landscape", V40)).toBe(
      "公募の納品用・縦書き・40字×40行・句読点のぶら下げあり（A4横置き 297mm × 210mm・余白20mm）"
    );
    expect(describeGrid("a4-portrait", { ...V40, hanging: false, vertical: false }, 10)).toBe(
      "公募の納品用・横書き・40字×40行・句読点のぶら下げなし（A4縦置き 210mm × 297mm・余白10mm）"
    );
  });

  test("外のものを読み込まない", () => {
    const out = grid();

    expect(out).not.toMatch(/<script[^>]*\ssrc=/);
    expect(out).not.toContain("http://");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("<link");
  });
});

describe("紙", () => {
  test("A4の横置きと縦置き", () => {
    expect(gridPaper("a4-landscape")).toMatchObject({ width: 297, height: 210 });
    expect(gridPaper("a4-portrait")).toMatchObject({ width: 210, height: 297 });
  });
});

/**
 * 余白を選ぶ（作者の裁定、2026-10-09）。A4縦置きの40×40は字が約8ptになるので、
 * 「普通（20mm）／狭く（10mm）」を選べるようにする。既定は普通。
 */
describe("余白", () => {
  test("普通（20mm）と狭く（10mm）があり、既定は普通", () => {
    expect(GRID_MARGINS.map((margin) => margin.mm)).toEqual([20, 10]);
    expect(GRID_MARGINS[0].mm).toBe(GRID_MARGIN_MM);
    expect(GRID_MARGIN_MM).toBe(20);
  });

  test("選ばなければ普通の余白で組む", () => {
    const out = grid();
    expect(out).toContain(".page-body { position: absolute; top: 20mm; right: 20mm; bottom: 20mm; left: 20mm;");
  });

  test("狭くすると、面の余白も上下の帯も10mmになり、字の大きさは寸法の計算どおり", () => {
    const out = buildGridPrintHtml({
      workTitle: "銀の航路",
      episodes: [{ heading: "第1話", body: BODY, notation: "curly" }],
      paper: "a4-portrait",
      grid: V40,
      marginMm: 10,
    });
    const geometry = gridGeometry(210, 297, 10, V40);

    expect(out).toContain(".page-body { position: absolute; top: 10mm; right: 10mm; bottom: 10mm; left: 10mm;");
    expect(out).toContain(".page-head, .page-foot { position: absolute; left: 10mm; right: 10mm; height: 10mm;");
    expect(out).toContain(`font-size: ${geometry.cell}mm;`);
    expect(out).toContain(`block-size: ${geometry.pitch}mm;`);
    // 案内帯にも余白が出る
    expect(out).toContain(describeGrid("a4-portrait", V40, 10));
  });

  test("A4縦置き・縦書き40×40：普通で約8pt、狭くで約9pt", () => {
    expect(gridFontSizePt("a4-portrait", V40, 20)).toBeCloseTo(8.0, 1);
    expect(gridFontSizePt("a4-portrait", V40, 10)).toBeCloseTo(9.0, 1);
  });

  /*
    上下の帯の字（題名・作者名・ページ番号）と、本文の範囲からはみ出すもの
    （縦書きのぶら下げ・横書きの上の行のルビと傍点）が重ならないこと。
    40×40 は向き・紙・余白のどれでも重ならない（作者が使う形）
  */
  test.each([
    ["a4-landscape", true],
    ["a4-portrait", true],
    ["a4-portrait", false],
  ] as const)("40字×40行（%s・縦書き=%s）は、普通でも狭くでも上下の字と重ならない", (paper, vertical) => {
    for (const margin of GRID_MARGINS) {
      expect(gridMarginClear(paper, { ...V40, vertical }, margin.mm)).toBe(true);
    }
  });

  test("ぶら下げが下の帯へ届く組み合わせは、重なると判定する（狭くを出さない）", () => {
    // 縦書き・A4横置き・40字×30行：狭くするとマスが4.75mmで、ぶら下げた「。」が下の帯の字に届く
    const v30 = { columns: 40, rows: 30, hanging: true, vertical: true };
    expect(gridMarginClear("a4-landscape", v30, 20)).toBe(true);
    expect(gridMarginClear("a4-landscape", v30, 10)).toBe(false);
    // ぶら下げないなら、下の帯へは何もはみ出さない
    expect(gridMarginClear("a4-landscape", { ...v30, hanging: false }, 10)).toBe(true);
  });

  /** 設計書 6.33.5 に書いた「狭くが出ない組み合わせ」を固定する（係数を変えたら文書も直す） */
  test.each([
    ["a4-landscape", { columns: 40, rows: 30, hanging: true, vertical: true }],
    ["a4-landscape", { columns: 20, rows: 20, hanging: true, vertical: true }],
    ["a4-portrait", { columns: 20, rows: 20, hanging: true, vertical: false }],
    ["a4-portrait", { columns: 20, rows: 20, hanging: false, vertical: false }],
  ] as const)("狭くが出ない：%s %o", (paper, options) => {
    expect(gridMarginClear(paper, options, 10)).toBe(false);
  });

  test.each([
    ["a4-landscape", { columns: 40, rows: 30, hanging: false, vertical: true }],
    ["a4-landscape", { columns: 20, rows: 20, hanging: false, vertical: true }],
    ["a4-portrait", { columns: 40, rows: 30, hanging: true, vertical: true }],
    ["a4-portrait", { columns: 20, rows: 20, hanging: true, vertical: true }],
    ["a4-portrait", { columns: 40, rows: 30, hanging: true, vertical: false }],
  ] as const)("狭くが出る：%s %o", (paper, options) => {
    expect(gridMarginClear(paper, options, 10)).toBe(true);
  });
});

/**
 * 台本の升目の字下げ（作者の裁定、2026-10-09）：柱 0字・ト書き 3字下げ・台詞 0字。
 * 字下げは空のマスとして並べる（1行の字数は指定どおりのまま）。
 */
describe("台本の字下げ", () => {
  test("ト書きの行頭に、空のマスが3つ並ぶ", () => {
    const out = buildGridPrintHtml({
      workTitle: "夜の駅",
      episodes: [{ heading: "", body: "○駅前・夜\n　太郎、ドアを開ける。\n太郎「行こう」", notation: "curly" }],
      paper: "a4-landscape",
      grid: V40,
      kind: "script",
    });
    expect(out).toContain('<div class="gl"><i>○</i><i>駅</i>');
    expect(out).toContain('<div class="gl"><i></i><i></i><i></i><i>太</i><i>郎</i><i>、</i>');
    expect(out).toContain('<div class="gl"><i>太</i><i>郎</i><i>「</i>');
  });
});
