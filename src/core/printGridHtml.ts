import { escapeHtml } from "./manuscriptRender";
import {
  buildPrintGuide,
  pageSheetCss,
  PRINT_FONT_FAMILY,
  type HeaderFooter,
  type PrintEpisode,
} from "./printHtml";
import { PRINT_PAGINATE_SCRIPT } from "./printPaginate";
import {
  gridGeometry,
  layoutGrid,
  type GridLine,
  type GridOptions,
  type GridPage,
  type GridUnit,
} from "./manuscriptGrid";

/**
 * 公募の納品用の組版を、印刷用HTMLにする（設計書6.33.5 の3）。
 *
 * 行とページは `manuscriptGrid.ts` が決め、ここは**決まったマスを並べる
 * だけ**である。面（紙1枚）もここで組んで渡すので、ブラウザの中の
 * スクリプトは割り直さず、上下の余白を埋めてページを数えるだけにする
 * （`body[data-grid="1"]`）。
 *
 * 面の見せ方（灰色の机・白い面・案内帯・印刷では帯を消す）は、ふつうの紙
 * （`printHtml.ts`）と同じ部品を使う。
 *
 * VS Code API に依存しない。
 */

/** 公募で使う紙 */
export type GridPaper = "a4-landscape" | "a4-portrait";

export interface GridPaperInfo {
  id: GridPaper;
  label: string;
  /** mm */
  width: number;
  /** mm */
  height: number;
}

export const GRID_PAPERS: readonly GridPaperInfo[] = [
  { id: "a4-landscape", label: "A4横置き", width: 297, height: 210 },
  { id: "a4-portrait", label: "A4縦置き", width: 210, height: 297 },
];

export function gridPaper(id: GridPaper): GridPaperInfo {
  const found = GRID_PAPERS.find((paper) => paper.id === id);
  if (!found) throw new Error(`知らない紙です: ${id}`);
  return found;
}

/**
 * 紙の端から本文までの余白（mm）。
 *
 * ふつうの紙（15mm）より広くとる。公募の原稿は綴じたり書き込んだりされる
 * ことがあり、上下の余白にはページ番号も入る。
 */
export const GRID_MARGIN_MM = 20;

/**
 * 公募の上下の余白の既定：上は何も刷らず、下にページ番号。
 *
 * **作者名は既定に入れない。** 公募には、審査の公平のため原稿に名前を
 * 出さない決まりのものがある。
 */
export const GRID_HEADER_FOOTER: HeaderFooter = { top: "none", bottom: "page" };

export interface GridPrintHtmlInput {
  workTitle: string;
  episodes: readonly PrintEpisode[];
  paper: GridPaper;
  grid: GridOptions;
  /** 省略なら `GRID_HEADER_FOOTER` */
  headerFooter?: HeaderFooter;
  author?: string;
}

/** 案内帯と選ぶ画面に出す、組み方の説明 */
export function describeGrid(paper: GridPaper, grid: GridOptions): string {
  const info = gridPaper(paper);
  return (
    `公募の納品用・${grid.vertical ? "縦書き" : "横書き"}・${grid.columns}字×${grid.rows}行・` +
    `句読点のぶら下げ${grid.hanging ? "あり" : "なし"}` +
    `（${info.label} ${info.width}mm × ${info.height}mm）`
  );
}

export function buildGridPrintHtml(input: GridPrintHtmlInput): string {
  const paper = gridPaper(input.paper);
  const title = escapeHtml(input.workTitle.trim() || "無題");
  const margins = input.headerFooter ?? GRID_HEADER_FOOTER;
  const author = escapeHtml((input.author ?? "").trim());
  const pages = layoutGrid(input.episodes, input.grid);

  return [
    "<!DOCTYPE html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    "<style>",
    buildGridStyle(paper, input.grid),
    "</style>",
    "</head>",
    `<body data-grid="1" data-vertical="${input.grid.vertical ? "1" : "0"}" data-head="${margins.top}" data-foot="${margins.bottom}" data-title="${title}" data-author="${author}">`,
    buildPrintGuide(escapeHtml(describeGrid(input.paper, input.grid)), margins),
    '<div id="print-pages">',
    // 扉（題だけ）。上下の余白には何も刷らない（スクリプトが飛ばす）
    `<div class="page page-cover"><div class="page-head"></div><div class="page-body"><h1 class="cover-title">${title}</h1></div><div class="page-foot"></div></div>`,
    ...pages.map(renderPage),
    "</div>",
    "<script>",
    PRINT_PAGINATE_SCRIPT,
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderPage(page: GridPage): string {
  return (
    `<div class="page grid-page" data-heading="${escapeHtml(page.heading)}">` +
    '<div class="page-head"></div><div class="page-body">\n' +
    page.lines.map(renderLine).join("\n") +
    '\n</div><div class="page-foot"></div></div>'
  );
}

function renderLine(line: GridLine): string {
  const cells = line.units.map(renderUnit).join("");
  // ぶら下げは最後のマスのあとに置く。行の枠からはみ出して、余白に出る
  const hang = line.hang ? renderUnit(line.hang) : "";
  return `<div class="gl">${cells}${hang}</div>`;
}

/**
 * 1つの部品を、マスの札にする。**文字は必ず逃がす。**
 *
 * 札を短くしてある（`<i>` がマス、`<b>` がルビのかたまり）。4万字の作品で
 * マスが4万個並ぶので、`<span class="…">` にするとファイルが倍になる。
 */
function renderUnit(unit: GridUnit): string {
  if (unit.kind === "ruby") {
    const base = [...unit.text].map((ch) => `<i>${escapeHtml(ch)}</i>`).join("");
    return `<b>${base}<span class="rt">${escapeHtml(unit.reading ?? "")}</span></b>`;
  }
  const names: string[] = [];
  if (unit.kind === "tcy") names.push("t");
  if (unit.kind === "half") names.push("h");
  if (unit.emphasis) names.push("e");
  const attr = names.length > 0 ? ` class="${names.join(" ")}"` : "";
  return `<i${attr}>${escapeHtml(unit.text)}</i>`;
}

function buildGridStyle(paper: GridPaperInfo, grid: GridOptions): string {
  const geometry = gridGeometry(paper.width, paper.height, GRID_MARGIN_MM, grid);
  const width = `${paper.width}mm`;
  const height = `${paper.height}mm`;
  const margin = `${GRID_MARGIN_MM}mm`;
  const vertical = grid.vertical
    ? [
        ".page-body { writing-mode: vertical-rl; }",
        ".page-head, .page-foot { writing-mode: horizontal-tb; }",
        // 3字以上の半角は1字ずつ立てる（縦中横にしない並び）
        ".gl i.h { text-orientation: upright; }",
      ]
    : [];

  return [
    // 面は組み上がっているので、印刷の余白は初めから0
    `@page { size: ${width} ${height}; margin: 0; }`,
    "html, body { margin: 0; padding: 0; }",
    "body {",
    `  font-family: ${PRINT_FONT_FAMILY};`,
    // 本文の字の大きさ＝1マス。上下の余白の字もこれを元に決まる
    `  font-size: ${geometry.cell}mm;`,
    "  line-height: 1;",
    "  color: #000;",
    "  background: #fff;",
    "}",
    ...vertical,
    "h1 { margin: 0; padding: 0; font-weight: normal; }",
    ".page-cover .page-body { text-align: center; }",
    ".cover-title { font-size: 2em; letter-spacing: 0.25em; margin-block-start: 25%; }",
    ...pageSheetCss(width, height, margin),
    // ぶら下げた句読点は本文の範囲の外（余白）に出るので、切り落とさない
    ".grid-page .page-body { overflow: visible; }",
    /*
      1行＝1つの箱。行送りの幅を持ち、マスを行の向きに並べる。
      マスは1字ぶんの正方形で、縮めも伸ばしもしない（字数が指定どおりに揃う）
    */
    `.gl { display: flex; align-items: center; block-size: ${geometry.pitch}mm; margin-inline-start: ${geometry.inlineOffset}mm; white-space: nowrap; }`,
    ".gl i, .gl b { font-style: normal; font-weight: normal; }",
    ".gl i { display: block; flex: none; inline-size: 1em; block-size: 1em; line-height: 1; text-align: center; }",
    ".gl i.t { text-combine-upright: all; -webkit-text-combine: horizontal; }",
    /*
      傍点：マスの外側（ルビと同じ側）にゴマ点を置く。**圏点（text-emphasis）は
      使わない**——1字ぶんの高さのマスでは、圏点が行の高さを押し広げて字が
      マスの下へずれる（ヘッドレスの Edge の横書きで確かめた）
    */
    ".gl i.e { position: relative; }",
    '.gl i.e::after { content: "\\FE45"; position: absolute; inset-inline-start: 0; inset-inline-end: 0; inset-block-start: -1.1em; font-size: 0.5em; line-height: 1; text-align: center; }',
    // ルビ：親文字のマスの外側（縦書きなら右、横書きなら上）に、半分の大きさで。
    // 読みが親文字より長くても、親文字の中央に揃えて左右（上下）へはみ出させる
    ".gl b { display: flex; flex: none; position: relative; }",
    ".gl b .rt { position: absolute; inset-inline-start: 0; inset-inline-end: 0; inset-block-start: -1.05em; display: flex; justify-content: center; font-size: 0.5em; line-height: 1; white-space: nowrap; }",
  ].join("\n");
}
