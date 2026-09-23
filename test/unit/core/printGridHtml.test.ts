import { describe, expect, test } from "vitest";
import {
  buildGridPrintHtml,
  describeGrid,
  GRID_HEADER_FOOTER,
  GRID_MARGIN_MM,
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
      "公募の納品用・縦書き・40字×40行・句読点のぶら下げあり（A4横置き 297mm × 210mm）"
    );
    expect(describeGrid("a4-portrait", { ...V40, hanging: false, vertical: false })).toBe(
      "公募の納品用・横書き・40字×40行・句読点のぶら下げなし（A4縦置き 210mm × 297mm）"
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
