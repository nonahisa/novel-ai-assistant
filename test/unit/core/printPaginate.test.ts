import { describe, expect, test } from "vitest";
import {
  PAGINATE_HELPERS,
  PRINT_PAGINATE_SCRIPT,
} from "../../../src/core/printPaginate";
import { NO_LINE_END, NO_LINE_START_STRICT } from "../../../src/core/kinsoku";

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

  /*
    読む紙は厳しい禁則（作者の裁定、2026-10-09）。実機の写真で、文庫の
    2ページ目の頭が「った。」から始まっていた
  */
  test("次の面の頭が小さい仮名なら、前の字ごと送る", () => {
    // 「あいう」で切ると次の面が「って」から始まる
    expect(cut(atoms("あいうって"), 3)).toBe(2);
  });

  test("次の面の頭が長音なら、前の字ごと送る", () => {
    expect(cut(atoms("あいコーヒー"), 3)).toBe(2);
  });

  test("厳しい側の字が入る（升目のゆるい側ではない）", () => {
    expect(PAGINATE_HELPERS).toContain(JSON.stringify(NO_LINE_START_STRICT));
  });
});

/**
 * 段落を部品へ割る（面の切れ目の単位）。縦中横（作者の裁定、2026-10-09）の
 * かたまりは、傍点の中でも**1つの部品**のまま扱う——1字ずつにほどくと、
 * 面に分けたあとで縦中横が消える。
 */
describe("段落の部品", () => {
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

  test("平文は1字ずつ、縦中横はかたまり1つ", () => {
    const atoms = atomsOf({ childNodes: [text("第"), element(["tcy"], "12"), text("時")] });
    expect(atoms.map((atom) => atom.t)).toEqual(["text", "node", "text"]);
  });

  test("傍点の中の縦中横も、かたまり1つ（傍点として1字ずつにほどかない）", () => {
    const atoms = atomsOf({
      childNodes: [element(["emphasis"], "あい"), element(["emphasis", "tcy"], "12")],
    });
    expect(atoms.map((atom) => atom.t)).toEqual(["em", "em", "node"]);
  });
});

/** ヘッダー・フッターの中身（設計書6.33.5 の2） */
describe("上下の余白に刷る中身", () => {
  type MarginText = (
    slot: string,
    info: { title: string; author: string; heading: string; number: number }
  ) => string;
  const marginText = new Function(
    `${PAGINATE_HELPERS}\nreturn marginText;`
  )() as MarginText;
  const info = { title: "銀の航路", author: "山田", heading: "第2話　雨", number: 7 };

  test.each([
    ["title", "銀の航路"],
    ["author", "山田"],
    ["episode", "第2話　雨"],
    ["page", "7"],
    ["none", ""],
  ])("%s → %s", (slot, expected) => {
    expect(marginText(slot, info)).toBe(expected);
  });

  test("知らない指定は、何も刷らない", () => {
    expect(marginText("date", info)).toBe("");
  });

  test("扉（番号0）にはページ番号を刷らない", () => {
    expect(marginText("page", { ...info, number: 0 })).toBe("");
  });
});

describe("スクリプトの形", () => {
  test("面に割ったあとで、上下の余白を埋める", () => {
    const paginateAt = PRINT_PAGINATE_SCRIPT.indexOf("paginate();");
    const decorateAt = PRINT_PAGINATE_SCRIPT.indexOf("decorate();");
    expect(decorateAt).toBeGreaterThan(paginateAt);
  });

  test("公募の納品用（面を組んで渡す）では割り直さず、余白を埋めて数えるだけ", () => {
    expect(PRINT_PAGINATE_SCRIPT).toContain("var grid = body.getAttribute('data-grid') === '1';");
    expect(PRINT_PAGINATE_SCRIPT).toContain("if (!grid) paginate();");
    // 失敗しても、組んで渡された面は消さない
    expect(PRINT_PAGINATE_SCRIPT).toContain(
      "if (!grid) { while (root.firstChild) root.removeChild(root.firstChild); }"
    );
  });

  test("上下の余白は文字として入れる（札として読ませない）", () => {
    // 題名や作者名に < があっても、紙に文字として出る
    expect(PRINT_PAGINATE_SCRIPT).toContain("cell.textContent = row ? marginText(row[column], info) : '';");
    expect(PRINT_PAGINATE_SCRIPT).not.toContain("innerHTML");
  });

  test("文として読める（構文の誤りで面が1枚も出ない、を防ぐ）", () => {
    expect(() => new Function(PRINT_PAGINATE_SCRIPT)).not.toThrow();
  });

  test("禁則の字は kinsoku.ts のものが入る（写しを置かない）", () => {
    expect(PAGINATE_HELPERS).toContain(JSON.stringify(NO_LINE_START_STRICT));
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

/**
 * 奇数・偶数ページごとの左・中央・右（作者の裁定、2026-10-17）。
 *
 * スクリプトを**そのまま**偽の document の上で走らせる（公募の納品用の道。面は
 * 組んで渡してあるので、割らずに上下の余白を埋めるだけ）。奇数・偶数はページ番号で
 * 決まり、扉には何も刷らないことを確かめる。
 */
describe("上下の余白を奇数・偶数ページで分けて埋める", () => {
  interface FakeEl {
    className: string;
    textContent: string;
    children: FakeEl[];
    attrs: Record<string, string>;
    ownerDocument: unknown;
    readonly firstChild: FakeEl | null;
    appendChild(child: FakeEl): FakeEl;
    removeChild(child: FakeEl): FakeEl;
    getAttribute(name: string): string | null;
    querySelector(selector: string): FakeEl | null;
    querySelectorAll(selector: string): FakeEl[];
    classList: { contains(name: string): boolean; add(name: string): void; remove(name: string): void };
  }

  function el(className = "", attrs: Record<string, string> = {}): FakeEl {
    const node: FakeEl = {
      className,
      textContent: "",
      children: [],
      attrs,
      ownerDocument: undefined,
      get firstChild() {
        return node.children[0] ?? null;
      },
      appendChild(child) {
        node.children.push(child);
        return child;
      },
      removeChild(child) {
        node.children = node.children.filter((item) => item !== child);
        return child;
      },
      getAttribute: (name) => (name in node.attrs ? node.attrs[name] : null),
      querySelector: (selector) => node.querySelectorAll(selector)[0] ?? null,
      querySelectorAll(selector) {
        const name = selector.replace(/^\./, "");
        const found: FakeEl[] = [];
        const walk = (item: FakeEl) => {
          for (const child of item.children) {
            if (child.className.split(" ").includes(name)) found.push(child);
            walk(child);
          }
        };
        walk(node);
        return found;
      },
      classList: {
        contains: (name) => node.className.split(" ").includes(name),
        add: (name) => {
          node.className = `${node.className} ${name}`.trim();
        },
        remove: (name) => {
          node.className = node.className.split(" ").filter((item) => item !== name).join(" ");
        },
      },
    };
    return node;
  }

  function page(cover: boolean): FakeEl {
    const p = el(cover ? "page page-cover" : "page grid-page", { "data-heading": "第1話　雨" });
    p.appendChild(el("page-head"));
    p.appendChild(el("page-body"));
    p.appendChild(el("page-foot"));
    return p;
  }

  function run(margins: unknown, pages: number): FakeEl[] {
    const root = el();
    const all = [page(true), ...Array.from({ length: pages }, () => page(false))];
    for (const item of all) root.appendChild(item);
    const body = el("", {
      "data-grid": "1",
      "data-vertical": "1",
      "data-margins": JSON.stringify(margins),
      "data-title": "銀の航路",
      "data-author": "山田",
    });
    const doc = {
      body,
      head: el(),
      getElementById: (id: string) => (id === "print-pages" ? root : null),
      createElement: () => {
        const made = el();
        made.ownerDocument = doc;
        return made;
      },
    };
    for (const item of all) {
      for (const part of item.children) part.ownerDocument = doc;
    }
    new Function("document", "window", PRINT_PAGINATE_SCRIPT)(doc, {});
    return all;
  }

  function cells(box: FakeEl | null): string[] {
    return (box?.children ?? []).map((cell) => `${cell.className}:${cell.textContent}`);
  }

  const none = { left: "none", center: "none", right: "none" };
  const margins = {
    odd: { top: { left: "none", center: "episode", right: "page" }, bottom: none },
    even: { top: { left: "page", center: "episode", right: "none" }, bottom: { ...none, center: "title" } },
  };

  test("奇数ページ（本文の1ページ目）はヘッダー右、偶数ページはヘッダー左に番号", () => {
    const [cover, first, second, third] = run(margins, 3);

    expect(cells(first.querySelector(".page-head"))).toEqual([
      "margin-left:",
      "margin-center:第1話　雨",
      "margin-right:1",
    ]);
    expect(cells(second.querySelector(".page-head"))).toEqual([
      "margin-left:2",
      "margin-center:第1話　雨",
      "margin-right:",
    ]);
    expect(cells(second.querySelector(".page-foot"))).toEqual([
      "margin-left:",
      "margin-center:銀の航路",
      "margin-right:",
    ]);
    expect(cells(third.querySelector(".page-head"))[2]).toBe("margin-right:3");
    // 扉には何も刷らない（枠も作らない）
    expect(cover.querySelector(".page-head")?.children).toEqual([]);
  });

  test("置き方が読めなければ、何も刷らない（面に分けることは止めない）", () => {
    const [, first] = run("壊れた", 1);
    expect(cells(first.querySelector(".page-head"))).toEqual([
      "margin-left:",
      "margin-center:",
      "margin-right:",
    ]);
  });
});
