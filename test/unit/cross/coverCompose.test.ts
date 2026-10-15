import { describe, expect, it } from "vitest";
import { buildEpubEditorPanelHtml } from "../../../src/views/epubEditorPanelHtml";
import { describeBakedPreview } from "../../../src/core/coverBake";

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
  baseline: string;
  /** 描いた時点の回転（ラジアン）。縦に並べる約物は90度回して描く */
  rotation: number;
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
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
}

/** `171.4px "Yu Mincho", serif` から大きさだけを取る */
function sizeOf(font: string): number {
  const found = /^([0-9.]+)px/.exec(font);
  return found ? Number(found[1]) : 0;
}

function makeContext(): FakeContext {
  // 平行移動と回転だけを持つ。drawTexts が使う変換はこの2つだけである
  let state = { tx: 0, ty: 0, rotation: 0 };
  const stack: (typeof state)[] = [];
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
      // 回したあとに描くのは (0, 0) だけなので、移した量を足せば
      // 回す前の座標（字の枠の中心）になる
      ctx.fills.push({
        text,
        x: x + state.tx,
        y: y + state.ty,
        size: sizeOf(ctx.font),
        align: ctx.textAlign,
        baseline: ctx.textBaseline,
        rotation: state.rotation,
      });
    },
    save() {
      stack.push({ ...state });
    },
    restore() {
      const top = stack.pop();
      if (top) state = top;
    },
    translate(x: number, y: number) {
      state = { ...state, tx: state.tx + x, ty: state.ty + y };
    },
    rotate(angle: number) {
      state = { ...state, rotation: state.rotation + angle };
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
  verticalGlyphKind(character: string): string;
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
      " sources: sources, FRAME_WIDTH: FRAME_WIDTH, FRAME_HEIGHT: FRAME_HEIGHT," +
      " verticalGlyphKind: verticalGlyphKind };"
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

  /**
   * 実機確認リスト「既存の表紙の見え方が変わっていない」の縦書きの側（2026-10-15）。
   *
   * **期待値は、収める処理を入れる前（0.73.7 の直前、d6e49e1c^）の `drawTexts` の式から
   * 出している**——いまの式に合わせて書くと「いま＝いま」しか言えないため。
   * 当時の縦書きは、塊の幅 `fontSize * 1.2`、字の送り `fontSize * 1.05`、
   * 1文字ずつ塊の中央（`x + blockW / 2`）に置いていた。
   */
  it("収まっている縦書きの題名も、置き方は収める処理を入れる前と変わらない", () => {
    const harness = withImage(
      load({
        texts: { bookTitle: "短い題" },
        layout: titleOnly({ vertical: true, anchor: "top-right" }),
        canvasInDom: true,
      })
    );

    harness.api.drawCover("front");

    const base = Math.min(harness.api.FRAME_WIDTH, harness.api.FRAME_HEIGHT);
    const fontSize = base * 0.1;
    const margin = base * 0.07;
    const blockW = fontSize * 1.2;
    const x = harness.api.FRAME_WIDTH - margin - blockW;
    expect(harness.ctx.fills.map((fill) => fill.text)).toEqual(["短", "い", "題"]);
    harness.ctx.fills.forEach((fill, index) => {
      expect(fill.size).toBeCloseTo(fontSize, 6);
      expect(fill.x).toBeCloseTo(x + blockW / 2, 6);
      expect(fill.y).toBeCloseTo(margin + index * fontSize * 1.05, 6);
    });
  });
});

/**
 * 実機確認リスト「折り返しの見た目。題名を30〜60文字にして『大』『横』で焼き、
 * 行が重なっていないか・読めるか」のうち、**重なっていないか**（2026-10-15）。
 *
 * 字の置き場所だけで決まる幾何なので測れる。読めるか（字の形・色・余白の
 * 釣り合い）は写真を見て作者が決める。
 */
describe("折り返した題名の行が重ならない", () => {
  for (const length of [30, 60]) {
    it(`横向き・${length}文字：行の頭の間が字の大きさ以上あく`, () => {
      const harness = withImage(
        load({
          texts: { bookTitle: "あ".repeat(length) },
          layout: titleOnly({ vertical: false, size: "large" }),
          canvasInDom: true,
        })
      );

      harness.api.drawCover("front");

      const fills = [...harness.ctx.fills].sort((a, b) => a.y - b.y);
      // 折り返している（1行なら、この試験は何も確かめていない）
      expect(fills.length).toBeGreaterThan(1);
      for (let i = 1; i < fills.length; i++) {
        // 字の上端（textBaseline は top）から次の行の上端まで、字の高さ以上
        expect(fills[i].y - fills[i - 1].y).toBeGreaterThanOrEqual(fills[i - 1].size);
      }
    });

    it(`縦向き・${length}文字：列の間が字の幅以上あき、列の中の字も重ならない`, () => {
      const harness = withImage(
        load({
          texts: { bookTitle: "あ".repeat(length) },
          layout: titleOnly({ vertical: true, anchor: "top-right", size: "large" }),
          canvasInDom: true,
        })
      );

      harness.api.drawCover("front");

      const fills = harness.ctx.fills;
      const size = fills[0].size;
      const columns = [...new Set(fills.map((fill) => fill.x))].sort((a, b) => a - b);
      // 縦は書く向きの枠が長いので、30文字は縮めれば1列に収まる（折り返さない）。
      // 60文字は折り返す（1列なら、列の間の確かめは何もしていないことになる）
      if (length === 30) expect(columns.length).toBe(1);
      else expect(columns.length).toBeGreaterThan(1);
      for (let i = 1; i < columns.length; i++) {
        expect(columns[i] - columns[i - 1]).toBeGreaterThanOrEqual(size);
      }
      for (const columnX of columns) {
        const ys = fills
          .filter((fill) => fill.x === columnX)
          .map((fill) => fill.y)
          .sort((a, b) => a - b);
        for (let i = 1; i < ys.length; i++) {
          expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(size);
        }
      }
    });
  }
});

/**
 * 縦に並べる題名の約物と小書きの仮名（作者の裁定、2026-10-15 23時）。
 *
 * 縦の題名は drawTexts が1字ずつ積む（canvas の書字方向は横に戻してある。
 * 0.107.1）。そのままでは「ー」「…」「～」が横向きのまま、括弧は横組みの形、
 * 小書きの仮名と句読点は横組みの位置（字の枠の左下寄り）のまま焼けていた。
 *
 * - 回す字（長音・波ダッシュ・ダッシュ・三点リーダー・括弧類）は、字の枠の
 *   中心で時計回りに90度回して描く
 * - 小書きの仮名・句読点は、字の枠の右上寄りへずらす
 * - それ以外の字と、横に並べる題名は、これまでと1pxも変えない
 */
describe("縦に並べる題名の約物", () => {
  function api(): CoverApi {
    return load({ texts: {}, layout: titleOnly({}), canvasInDom: true }).api;
  }

  it("回す字の表：長音・波ダッシュ・ダッシュ・三点リーダー・括弧類", () => {
    const kind = api().verticalGlyphKind;
    for (const character of Array.from(
      "ー～〜―—‐－─…‥「」『』（）［］｛｝〔〕【】〈〉《》〘〙〖〗()[]{}<>＜＞"
    )) {
      expect(kind(character), character).toBe("rotate");
    }
  });

  it("小書きの仮名の表", () => {
    const kind = api().verticalGlyphKind;
    for (const character of Array.from(
      "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ"
    )) {
      expect(kind(character), character).toBe("small");
    }
  });

  it("句読点の表", () => {
    const kind = api().verticalGlyphKind;
    for (const character of Array.from("、。，．")) {
      expect(kind(character), character).toBe("punct");
    }
  });

  it("ふつうの字・感嘆符・疑問符・中黒はそのまま立てる", () => {
    const kind = api().verticalGlyphKind;
    for (const character of Array.from("あ漢字アつやゆよA1！？・")) {
      expect(kind(character), character).toBe("upright");
    }
  });

  /** 題名を右上に縦で置いて、描いた字と、字の枠の物差しを返す */
  function drawVertical(title: string): {
    fills: Fill[];
    size: number;
    centerX: number;
    top: number;
  } {
    const harness = withImage(
      load({
        texts: { bookTitle: title },
        layout: titleOnly({ vertical: true, anchor: "top-right" }),
        canvasInDom: true,
      })
    );
    harness.api.drawCover("front");
    const base = Math.min(harness.api.FRAME_WIDTH, harness.api.FRAME_HEIGHT);
    const size = base * 0.1;
    const margin = base * 0.07;
    const blockW = size * 1.2;
    return {
      fills: harness.ctx.fills,
      size,
      centerX: harness.api.FRAME_WIDTH - margin - blockW + blockW / 2,
      top: margin,
    };
  }

  it("回す字は、字の枠の中心で時計回りに90度回して描く", () => {
    const { fills, size, centerX, top } = drawVertical("「あー…」");
    expect(fills.map((fill) => fill.text)).toEqual(["「", "あ", "ー", "…", "」"]);
    for (const index of [0, 2, 3, 4]) {
      const fill = fills[index];
      expect(fill.rotation, fill.text).toBeCloseTo(Math.PI / 2, 9);
      expect(fill.align).toBe("center");
      expect(fill.baseline).toBe("middle");
      expect(fill.x).toBeCloseTo(centerX, 6);
      // 字の枠（上端から1em）の真ん中。送りは立てる字と同じ 1.05em
      expect(fill.y).toBeCloseTo(top + index * size * 1.05 + size / 2, 6);
    }
    // 回したあとに立てる字が回ったまま残らない（save と restore の対）
    expect(fills[1].rotation).toBe(0);
    expect(fills[1].baseline).toBe("top");
    expect(fills[1].x).toBeCloseTo(centerX, 6);
    expect(fills[1].y).toBeCloseTo(top + size * 1.05, 6);
  });

  it("小書きの仮名は、字の枠の右上寄りへずらす", () => {
    const { fills, size, centerX, top } = drawVertical("あっゃ");
    for (const index of [1, 2]) {
      const fill = fills[index];
      const normalY = top + index * size * 1.05;
      expect(fill.rotation).toBe(0);
      expect(fill.x).toBeGreaterThan(centerX);
      expect(fill.y).toBeLessThan(normalY);
      // ずらしすぎて隣の字の枠へ出ない（ずれは字の大きさの半分未満）
      expect(fill.x - centerX).toBeLessThan(size / 2);
      expect(normalY - fill.y).toBeLessThan(size / 2);
    }
  });

  it("句読点は小書きの仮名より大きく、右上の隅へ寄せる", () => {
    const { fills, size, centerX, top } = drawVertical("あっ、。");
    const small = fills[1];
    const smallDx = small.x - centerX;
    const smallDy = top + 1 * size * 1.05 - small.y;
    for (const index of [2, 3]) {
      const fill = fills[index];
      const dx = fill.x - centerX;
      const dy = top + index * size * 1.05 - fill.y;
      expect(fill.rotation).toBe(0);
      expect(dx).toBeGreaterThan(smallDx);
      expect(dy).toBeGreaterThan(smallDy);
      // 字の枠の外までは出さない
      expect(dx).toBeLessThan(size);
      expect(dy).toBeLessThan(size);
    }
  });

  it("横に並べる題名は、約物を含んでいても1行のまま回さずに描く", () => {
    const harness = withImage(
      load({
        texts: { bookTitle: "「あっ…」、。" },
        layout: titleOnly({ vertical: false }),
        canvasInDom: true,
      })
    );
    harness.api.drawCover("front");
    expect(harness.ctx.fills).toHaveLength(1);
    expect(harness.ctx.fills[0].text).toBe("「あっ…」、。");
    expect(harness.ctx.fills[0].rotation).toBe(0);
    expect(harness.ctx.fills[0].baseline).toBe("top");
  });
});
