import { describe, expect, test } from "vitest";
import {
  buildPrintHtml,
  PRINT_DASH_FONT_FAMILY,
  PRINT_DASH_GOTHIC_FONT_FAMILY,
  type PrintEpisode,
} from "../../../src/core/printHtml";
import { buildGridPrintHtml } from "../../../src/core/printGridHtml";
import { layoutGrid, type GridOptions } from "../../../src/core/manuscriptGrid";
import { PAGINATE_HELPERS } from "../../../src/core/printPaginate";
import {
  dashRuns,
  MARK_DASH_CHARS,
  MARK_FONT_GOTHIC,
  MARK_FONT_MINCHO,
  PRINT_DASH_CHARS,
} from "../../../src/core/markFont";

/**
 * 紙のダッシュの書体（設計書6.33.6）。
 *
 * 作者の実機の報告（2026-10-19）：文庫で書き出して Chrome で開くと、
 * 第1話の末尾「僕らは、無力だ――――」の線が切れていた。紙の明朝の先頭が
 * 游明朝で、ダッシュが字送りより短いため。
 *
 * 書体名で繋がるかどうかは機械では測れないので、ここで見るのは
 * 「印で包まれ、繋がる書体の列が当たること」と「面の切れ目の数え方が
 * 包む前と変わらないこと」。見た目はヘッドレスのブラウザで刷って確かめる。
 */

// 見た目がほぼ同じ別の字なので、符号から作る
const BAR = String.fromCodePoint(0x2015);
const EM = String.fromCodePoint(0x2014);

const episode = (body: string, heading = "第1話"): PrintEpisode => ({
  heading,
  body,
  notation: "curly",
});

const bunko = (body: string, heading?: string) =>
  buildPrintHtml({ workTitle: "作品", episodes: [episode(body, heading)], preset: "bunko-vertical" });

describe("続いたダッシュの区間", () => {
  test("続きは1つの区間にまとめる", () => {
    expect(dashRuns(`無力だ${BAR.repeat(4)}`)).toEqual([{ start: 3, end: 7 }]);
  });

  test("欧文のダッシュも同じ印。離れた区間は別々", () => {
    expect(dashRuns(`あ${EM}${EM}い${BAR}う`)).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 5 },
    ]);
  });

  test("ダッシュが無ければ空", () => {
    expect(dashRuns("ただの文。ーーー")).toEqual([]);
  });

  test("字の集合は原稿エディターと同じ2字", () => {
    expect([...MARK_DASH_CHARS].map((ch) => ch.codePointAt(0))).toEqual([0x2014, 0x2015]);
  });
});

describe("読む紙のダッシュ", () => {
  test("作者の報告の行：4本が1つの印に包まれる", () => {
    const html = bunko(`　僕らは、無力だ${BAR.repeat(4)}`);
    expect(html).toContain(`<p>　僕らは、無力だ<span class="dash">${BAR.repeat(4)}</span></p>`);
  });

  test("印には、原稿エディターと同じ繋がる明朝の列が当たり、字送りも行の高さも広げない", () => {
    expect(PRINT_DASH_FONT_FAMILY).toBe(MARK_FONT_MINCHO);
    // line-height: 0 … 倒し先の書体は行の箱が少し高く（ヘッドレスの Edge で 180→183）、
    // 印のある行だけ行送りが伸びて面の切れ目が動いた
    expect(bunko(BAR)).toContain(
      `.dash { font-family: ${MARK_FONT_MINCHO}; letter-spacing: 0; line-height: 0; }`
    );
  });

  test("欧文の U+2014 は包まない（游明朝で繋がり、倒し先の BIZ UD明朝では半角に縮むため）", () => {
    expect([...PRINT_DASH_CHARS].map((ch) => ch.codePointAt(0))).toEqual([0x2015]);
    const html = bunko(`あ${EM.repeat(4)}い${BAR}${BAR}う`);
    expect(html).toContain(`<p>あ${EM.repeat(4)}い<span class="dash">${BAR}${BAR}</span>う</p>`);
  });

  test("話の見出しのダッシュも包む", () => {
    expect(bunko("本文", `第1話　夜${BAR}${BAR}朝`)).toContain(
      `<h2 class="episode-heading">第<span class="tcy">1</span>話　夜<span class="dash">${BAR}${BAR}</span>朝</h2>`
    );
  });

  test("印で包んでも、作者の本文は文字として逃がす", () => {
    const html = bunko(`<b>${BAR}${BAR}&`);
    expect(html).toContain(`<p>&lt;b&gt;<span class="dash">${BAR}${BAR}</span>&amp;</p>`);
  });

  test("印を外せば、包む前と同じ段落に戻る（ほかの字は動かさない）", () => {
    const line = `　「待って${BAR}${BAR}」と言った。${EM}${EM}${EM}${EM}それから|雨《あめ》が《《ふった》》。`;
    // ルビ・傍点の記法（|《》）は投稿サイトの記法で組む
    const html = buildPrintHtml({
      workTitle: "作品",
      episodes: [{ heading: "", body: line, notation: "site" }],
      preset: "bunko-vertical",
    });
    // 案内帯にも <p> があるので、本文の段落を書き出しで探す
    const paragraph = html.match(/<p>　「待って.*<\/p>/)?.[0] ?? "";
    const unwrapped = paragraph.replace(/<span class="dash">([^<]*)<\/span>/g, "$1");
    expect(paragraph).not.toBe(unwrapped);
    expect(unwrapped).toBe(
      `<p>　「待って${BAR}${BAR}」と言った。${EM}${EM}${EM}${EM}それから<ruby>雨<rt>あめ</rt></ruby>が<span class="emphasis">ふった</span>。</p>`
    );
  });

  test("台本のト書き（ゴシック）のダッシュには、ゴシックの繋がる列を当てる", () => {
    expect(PRINT_DASH_GOTHIC_FONT_FAMILY).toBe(MARK_FONT_GOTHIC);
    const html = buildPrintHtml({
      workTitle: "台本",
      episodes: [episode(`　太郎、走る${BAR}${BAR}`)],
      preset: "bunko-vertical",
      kind: "script",
    });
    expect(html).toContain(`.script-togaki .dash`);
    expect(html).toContain(`{ font-family: ${MARK_FONT_GOTHIC}; }`);
    expect(html).toContain(`<span class="dash">${BAR}${BAR}</span>`);
  });
});

describe("面の切れ目は包む前と変わらない", () => {
  type Atom = { t: string; s: string };
  type FakeNode = {
    nodeType: number;
    nodeValue?: string;
    textContent?: string;
    classList?: { contains: (name: string) => boolean };
  };
  const atomsOf = new Function(`${PAGINATE_HELPERS}\nreturn atomsOf;`)() as (block: {
    childNodes: FakeNode[];
  }) => Atom[];
  const text = (value: string): FakeNode => ({ nodeType: 3, nodeValue: value });
  const element = (classes: string[], value: string): FakeNode => ({
    nodeType: 1,
    textContent: value,
    classList: { contains: (name: string) => classes.includes(name) },
  });

  test("包んだ段落と包まない段落で、部品の数と字の並びが同じ", () => {
    const before = atomsOf({ childNodes: [text(`僕らは、無力だ${BAR.repeat(4)}。そして`)] });
    const after = atomsOf({
      childNodes: [text("僕らは、無力だ"), element(["dash"], BAR.repeat(4)), text("。そして")],
    });
    expect(after.length).toBe(before.length);
    // 禁則の判定（cutForKinsoku）に渡る字の並びも同じ
    expect(after.map((atom) => atom.s)).toEqual(before.map((atom) => atom.s));
    // ダッシュは1字ずつの部品（かたまり1つにしない）
    expect(after.filter((atom) => atom.t === "dash").map((atom) => atom.s)).toEqual([
      BAR,
      BAR,
      BAR,
      BAR,
    ]);
  });
});

describe("上下の帯（話の見出し・題名）のダッシュ", () => {
  type Child = { kind: "text" | "dash"; text: string };
  const appendMarked = new Function(`${PAGINATE_HELPERS}\nreturn appendMarked;`)() as (
    cell: unknown,
    text: string
  ) => void;
  // 帯の枠の作り物。作られた子を順に並べる
  const fakeCell = () => {
    const children: Child[] = [];
    const cell = {
      ownerDocument: {
        createElement: () => ({ className: "", textContent: "" }),
        createTextNode: (text: string) => ({ nodeValue: text }),
      },
      appendChild: (node: { className?: string; textContent?: string; nodeValue?: string }) => {
        if (node.className === "dash") children.push({ kind: "dash", text: node.textContent ?? "" });
        else children.push({ kind: "text", text: node.nodeValue ?? "" });
      },
    };
    return { cell, children };
  };

  test("続いたダッシュを1つの印で包み、ほかは文字のまま", () => {
    const { cell, children } = fakeCell();
    appendMarked(cell, `第1話　無力${BAR}${BAR}の夜`);
    expect(children).toEqual([
      { kind: "text", text: "第1話　無力" },
      { kind: "dash", text: `${BAR}${BAR}` },
      { kind: "text", text: "の夜" },
    ]);
  });

  test("空なら何も足さない", () => {
    const { cell, children } = fakeCell();
    appendMarked(cell, "");
    expect(children).toEqual([]);
  });
});

describe("公募の升目のダッシュ", () => {
  const grid: GridOptions = { columns: 20, rows: 20, hanging: true, vertical: true };

  test("ダッシュのマスに印が付き、繋がる明朝の列が当たる", () => {
    const html = buildGridPrintHtml({
      workTitle: "作品",
      episodes: [episode(`　僕らは、無力だ${BAR.repeat(4)}`)],
      paper: "a4-landscape",
      grid,
    });
    expect(html.match(/<i class="d">―<\/i>/g)?.length).toBe(4);
    expect(html).toContain(`.gl i.d { font-family: ${MARK_FONT_MINCHO}; }`);
    expect(html).toContain(`.gl.g i.d { font-family: ${MARK_FONT_GOTHIC}; }`);
  });

  test("面の数は組版（layoutGrid）のまま", () => {
    const episodes = [episode(`　${"風が吹いた。".repeat(80)}${BAR.repeat(4)}`.repeat(3))];
    const html = buildGridPrintHtml({ workTitle: "作品", episodes, paper: "a4-landscape", grid });
    expect(html.match(/class="page grid-page"/g)?.length).toBe(layoutGrid(episodes, grid).length);
  });
});
