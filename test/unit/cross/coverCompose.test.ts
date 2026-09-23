import { describe, expect, it } from "vitest";
import { buildEpubEditorPanelHtml } from "../../src/views/epubEditorPanelHtml";
import { describeBakedPreview } from "../../src/core/coverBake";

/**
 * 表紙の合成（設計書6.65.8・6.65.9）。
 *
 * ## 画面のJSを、画面の外から動かす
 *
 * 合成ができるのは canvas だけなので、この計算は `core/` には置けない
 * （置くと写しが2つになり、片方だけが直る日が必ず来る——組んで書く面の
 * `compose:start` と同じ理由）。そこで**配られるHTMLから印
 * （`cover:start` 〜 `cover:end`）の間を切り出し、`new Function` で動かす**。
 * 試しているのは、そのまま画面へ渡る本物である。
 *
 * canvas はこの環境に無いので、**字の幅を「1文字＝字の大きさ」で返す偽物**
 * を渡す（実機の測定——11文字の題名が約1885px、字の大きさ171px——と同じ
 * 数え方）。描かずに、置いた場所と大きさだけを測る。
 */

const html = buildEpubEditorPanelHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));
const source = code.slice(
  code.indexOf("/* cover:start */"),
  code.indexOf("/* cover:end */")
);

/* ── 偽の canvas ───────────────────────────────── */

interface Fill {
  text: string;
  x: number;
  y: number;
  size: number;
  align: string;
}

interface FakeContext {
  font: string;
  fillStyle: string;
  textAlign: string;
  textBaseline: string;
  fills: Fill[];
  clearRect(): void;
  fillRect(): void;
  drawImage(): void;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
}

/** `171.4px "Yu Mincho", serif` から大きさだけを取る */
function sizeOf(font: string): number {
  const found = /^([0-9.]+)px/.exec(font);
  return found ? Number(found[1]) : 0;
}

function makeContext(): FakeContext {
  const ctx: FakeContext = {
    font: "",
    fillStyle: "",
    textAlign: "",
    textBaseline: "",
    fills: [],
    clearRect() {},
    fillRect() {},
    drawImage() {},
    // 日本語の全角は1文字＝1em。実機の測り方に合わせる
    measureText(text: string) {
      return { width: Array.from(text).length * sizeOf(ctx.font) };
    },
    fillText(text: string, x: number, y: number) {
      ctx.fills.push({
        text,
        x,
        y,
        size: sizeOf(ctx.font),
        align: ctx.textAlign,
      });
    },
  };
  return ctx;
}

interface FakeCanvas {
  width: number;
  height: number;
  getContext(): FakeContext;
  toDataURL(): string;
}

const PNG_DATA_URL = "data:image/png;base64,AAAA";

function makeCanvas(ctx: FakeContext): FakeCanvas {
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: () => PNG_DATA_URL,
  };
}

/* ── 切り出した本物の関数 ───────────────────── */

interface Style {
  visible: boolean;
  anchor: string;
  size: string;
  color: string;
  vertical: boolean;
}

interface Posted {
  type: string;
  side?: string;
  dataUrl?: string;
}

interface CoverApi {
  bake(side: string): void;
  drawCover(side: string, target?: FakeCanvas): void;
  images: Record<string, unknown>;
  sources: Record<string, string | null>;
  FRAME_WIDTH: number;
  FRAME_HEIGHT: number;
}

interface Harness {
  api: CoverApi;
  ctx: FakeContext;
  posts: Posted[];
  /** `document.createElement('canvas')` が呼ばれた回数 */
  created: number;
}

interface Options {
  /** 書誌の欄の値（題名など） */
  texts: Record<string, string>;
  /** 合成の指定 */
  layout: Record<string, Style | string>;
  /** プレビューに合成の canvas が出ているか（焼いた画像を出していると無い） */
  canvasInDom: boolean;
}

function load(options: Options): Harness {
  const ctx = makeContext();
  const shown = makeCanvas(ctx);
  const posts: Posted[] = [];
  let created = 0;

  const deps = {
    field: (id: string) => ({ value: options.texts[id] ?? "", checked: false }),
    ELEMENTS: ["title", "author", "illustrator", "label"],
    ELEMENT_FIELDS: {
      title: "bookTitle",
      author: "author",
      illustrator: "illustrator",
      label: "label",
    },
    readLayout: () => options.layout,
    frameBackgroundOf: () => "#000000",
    post: (type: string, payload: Record<string, unknown>) =>
      posts.push({ type, ...payload } as Posted),
    readForm: () => ({}),
    document: {
      getElementById: (id: string) =>
        options.canvasInDom && id.startsWith("canvas-") ? shown : null,
      createElement: () => {
        created += 1;
        return makeCanvas(ctx);
      },
    },
    Image: function FakeImage() {
      return {};
    },
  };

  const api = new Function(
    "deps",
    "const field = deps.field, ELEMENTS = deps.ELEMENTS," +
      " ELEMENT_FIELDS = deps.ELEMENT_FIELDS, readLayout = deps.readLayout," +
      " frameBackgroundOf = deps.frameBackgroundOf, post = deps.post," +
      " readForm = deps.readForm, document = deps.document, Image = deps.Image;\n" +
      source +
      "\nreturn { bake: bake, drawCover: drawCover, images: images," +
      " sources: sources, FRAME_WIDTH: FRAME_WIDTH, FRAME_HEIGHT: FRAME_HEIGHT };"
  )(deps) as CoverApi;

  return {
    api,
    ctx,
    posts,
    get created() {
      return created;
    },
  };
}

/** 元絵は読めている、という状態にする */
function withImage(harness: Harness): Harness {
  harness.api.images.front = { naturalWidth: 1200, naturalHeight: 1800 };
  harness.api.sources.front = "vscode-resource:/素材/表紙.png";
  return harness;
}

function style(over: Partial<Style>): Style {
  return {
    visible: true,
    anchor: "top-center",
    size: "large",
    color: "#ffffff",
    vertical: false,
    ...over,
  };
}

/** 題名だけを置く指定 */
function titleOnly(over: Partial<Style>): Record<string, Style | string> {
  return {
    title: style(over),
    author: style({ visible: false }),
    illustrator: style({ visible: false }),
    label: style({ visible: false }),
    frameBackground: "#000000",
  };
}

describe("切り出し", () => {
  it("印で挟んであり、切り出せる", () => {
    expect(source).toContain("function drawTexts(");
    expect(source).toContain("function bake(");
  });
});

/**
 * ① 案内の言葉と、実際の振る舞いを合わせる（作者の裁定、2026-09-21）。
 *
 * 焼いた画像があるあいだ、プレビューは合成のcanvasではなく**その画像**を
 * 出す（設計書6.65.13の3。見えているもの＝本に入るもの）。ところが焼く
 * ときに「画面に出ている canvas」を探しに行っていたので、焼いたあとは
 * ［表紙を焼く］が黙って何もしなかった——案内は「焼き直してください」と
 * 言うのに、先に［焼いた画像を消す］を押すまで焼き直せない。
 */
describe("焼いた画像があっても焼き直せる", () => {
  it("プレビューが焼いた画像でも、焼くと画像が届く", () => {
    const harness = withImage(
      load({
        texts: { bookTitle: "表紙の題名" },
        layout: titleOnly({}),
        canvasInDom: false,
      })
    );

    harness.api.bake("front");

    const baked = harness.posts.find((item) => item.type === "bake");
    expect(baked).toBeDefined();
    expect(baked?.side).toBe("front");
    expect(baked?.dataUrl).toBe(PNG_DATA_URL);
  });

  it("画面に canvas があるときは、それを使う（見えないものを余計に作らない）", () => {
    const harness = withImage(
      load({
        texts: { bookTitle: "表紙の題名" },
        layout: titleOnly({}),
        canvasInDom: true,
      })
    );

    harness.api.bake("front");

    expect(harness.posts.some((item) => item.type === "bake")).toBe(true);
    expect(harness.created).toBe(0);
  });

  /** 言葉と振る舞いを結んでおく（どちらかだけ直すと、また食い違う） */
  it("案内の言葉は「焼き直す」と言っている", () => {
    expect(describeBakedPreview(new Date(2026, 8, 21, 10, 30))).toContain(
      "焼き直して"
    );
  });
});

/**
 * ② 長い題名を枠に収める（作者の裁定、2026-09-21）。
 *
 * 実機の測定：「いじめられっ子_確認用」（11文字）を横向きで焼くと、
 * 題名の幅 約1885px に対して枠の幅は1714px で、両側が切れていた。
 * **小説の表紙は題名が読めることがすべてなので、切れるよりは小さいほうが
 * まし**——ただし小さすぎても読めないので、下限を割るときは折り返す。
 */
describe("長い題名を枠に収める", () => {
  /** 描いた字が占める、左端・右端（横書き）／上端・下端（縦書き） */
  function extents(harness: Harness): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } {
    const fills = harness.ctx.fills;
    expect(fills.length).toBeGreaterThan(0);
    const lefts: number[] = [];
    const rights: number[] = [];
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (const fill of fills) {
      const width = Array.from(fill.text).length * fill.size;
      // 縦書きは1文字ずつ中央寄せで置く（横書きは左端が x）
      lefts.push(fill.align === "center" ? fill.x - fill.size / 2 : fill.x);
      rights.push(fill.align === "center" ? fill.x + fill.size / 2 : fill.x + width);
      tops.push(fill.y);
      bottoms.push(fill.y + fill.size);
    }
    return {
      left: Math.min(...lefts),
      right: Math.max(...rights),
      top: Math.min(...tops),
      bottom: Math.max(...bottoms),
    };
  }

  it("実機で切れた題名が、横向きで枠に収まる", () => {
    const harness = withImage(
      load({
        texts: { bookTitle: "いじめられっ子_確認用" },
        layout: titleOnly({ vertical: false }),
        canvasInDom: true,
      })
    );

    harness.api.drawCover("front");

    const box = extents(harness);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(harness.api.FRAME_WIDTH);
    expect(box.bottom).toBeLessThanOrEqual(harness.api.FRAME_HEIGHT);
  });

  it("縮めても、読める大きさ（短い辺の3.5%）を下回らない", () => {
    const harness = withImage(
      load({
        texts: { bookTitle: "いじめられっ子_確認用" },
        layout: titleOnly({ vertical: false }),
        canvasInDom: true,
      })
    );

    harness.api.drawCover("front");

    const smallest = Math.min(...harness.ctx.fills.map((fill) => fill.size));
    expect(smallest).toBeGreaterThanOrEqual(harness.api.FRAME_WIDTH * 0.035);
  });

  it("下限まで縮めても入らない題名は、折り返して枠に収まる", () => {
    const harness = withImage(
      load({
        // 下限（短い辺の3.5%）でも1行に入らない長さ
        texts: { bookTitle: "あ".repeat(60) },
        layout: titleOnly({ vertical: false }),
        canvasInDom: true,
      })
    );

    harness.api.drawCover("front");

    // 折り返している（1行では描いていない）
    expect(harness.ctx.fills.length).toBeGreaterThan(1);
    const box = extents(harness);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(harness.api.FRAME_WIDTH);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(harness.api.FRAME_HEIGHT);
  });

  /**
   * **下限まで縮めてから折り返さない。** 折り返す余地があるのに読めない
   * 小ささにするのは、作者が選んだ「大」を無視することでもある。
   */
  it("折り返すときは、作者が選んだ大きさのままにする", () => {
    const harness = load({
      texts: { bookTitle: "あ".repeat(60) },
      layout: titleOnly({ vertical: false }),
      canvasInDom: true,
    });
    withImage(harness);

    harness.api.drawCover("front");

    const requested = harness.api.FRAME_WIDTH * 0.1;
    for (const fill of harness.ctx.fills) {
      expect(fill.size).toBeCloseTo(requested, 6);
    }
  });

  /**
   * 最後の手立て。**折り返しても入らないほど長ければ、下限を割ってでも
   * 枠に収める**——溢れた題名は、読めない以前に本の顔が壊れる。
   */
  it("折り返しても入らない長さは、下限を割ってでも枠に収める", () => {
    const harness = load({
      texts: { bookTitle: "あ".repeat(1000) },
      layout: titleOnly({ vertical: false }),
      canvasInDom: true,
    });
    withImage(harness);

    harness.api.drawCover("front");

    const box = extents(harness);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(harness.api.FRAME_WIDTH);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(harness.api.FRAME_HEIGHT);
  });

  it("縦向きでも同じように収まる（長ければ縦でも溢れる）", () => {
    const harness = withImage(
      load({
        texts: { bookTitle: "あ".repeat(60) },
        layout: titleOnly({ vertical: true, anchor: "top-right" }),
        canvasInDom: true,
      })
    );

    harness.api.drawCover("front");

    const box = extents(harness);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(harness.api.FRAME_HEIGHT);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(harness.api.FRAME_WIDTH);
  });

  /**
   * **既に焼いた画像の見た目を変えない**（作者の指示）。収まっている題名は
   * これまでと1pxも変えずに描く——直すのは、はみ出すものだけである。
   */
  it("収まっている題名の置き方は、これまでと変わらない", () => {
    const harness = withImage(
      load({
        texts: { bookTitle: "短い題" },
        layout: titleOnly({ vertical: false, anchor: "top-center" }),
        canvasInDom: true,
      })
    );

    harness.api.drawCover("front");

    const base = harness.api.FRAME_WIDTH;
    const fontSize = base * 0.1;
    const margin = base * 0.07;
    const width = 3 * fontSize;
    expect(harness.ctx.fills).toHaveLength(1);
    expect(harness.ctx.fills[0].size).toBeCloseTo(fontSize, 6);
    expect(harness.ctx.fills[0].x).toBeCloseTo((base - width) / 2, 6);
    expect(harness.ctx.fills[0].y).toBeCloseTo(margin, 6);
  });
});
