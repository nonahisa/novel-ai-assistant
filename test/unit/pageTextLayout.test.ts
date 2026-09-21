import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import {
  PAGE_LAYOUT_BLOCK_TYPES,
  defaultBookBlocks,
  defaultBookConfig,
  pageAlignLabels,
  pageLayoutClass,
  pageLayoutVertical,
  parseBookConfig,
  type BookConfig,
} from "../../src/models/book";
import {
  buildColophonFragment,
  buildEpub,
  buildEpubCss,
  buildTitlePageFragment,
  buildTocFragment,
  type EpubBook,
} from "../../src/core/epubPackage";
import { buildCharacterPageFragment } from "../../src/core/epubCharacterPage";
import { buildEpubEditorPanelHtml } from "../../src/views/epubEditorPanelHtml";

/**
 * 本文以外の面（中表紙・目次・人物紹介・あとがき・奥付）の文字の体裁
 * ——縦横と寄せ（作者の依頼、2026-09-13）。
 *
 * ここで見張るのは3つである。
 *
 * 1. **縦書きのときに、画面へ出す寄せの言葉が入れ替わること。** 縦組みで
 *    `block: "start"` は「右寄せ」であり、ここを間違えると作者は毎回逆を
 *    選ぶ（いちばん間違えやすいところ）
 * 2. **何も選んでいない面が、これまでと同じ出力になること**（回帰）
 * 3. **5面すべてに欄があること。** 面が増えたら落ちる形にしてある
 */

function book(config: BookConfig): EpubBook {
  return {
    config: { ...config, blocks: defaultBookBlocks(config) },
    chapters: [{ heading: "第一話", body: "あ", notation: "curly" }],
    cover: null,
    backCover: null,
    identifier: "urn:uuid:00000000-0000-4000-8000-000000000000",
    modified: "2026-09-13T00:00:00Z",
  };
}

function open(zip: Uint8Array): Record<string, string> {
  const decoder = new TextDecoder();
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(unzipSync(zip))) {
    out[name] = decoder.decode(bytes);
  }
  return out;
}

describe("寄せの呼び名（縦横で入れ替わる）", () => {
  /**
   * 横書きの本。行は上から下へ進み、字は左から右へ進む。
   */
  it("横書きでは、行の向きが上下・字の向きが左右になる", () => {
    const block = pageAlignLabels("block", false);
    const inline = pageAlignLabels("inline", false);

    expect(block.axis).toBe("上下の寄せ");
    expect(block.options.map((choice) => choice.label)).toEqual([
      "上寄せ",
      "中央",
      "下寄せ",
    ]);
    expect(inline.axis).toBe("左右の寄せ");
    expect(inline.options.map((choice) => choice.label)).toEqual([
      "左寄せ",
      "中央",
      "右寄せ",
    ]);
  });

  /**
   * **ここが要。** 縦組みでは行が右から左へ進むので、`block: "start"` は
   * 「右寄せ」になる。字は上から下へ進むので、`inline` が上下になる。
   */
  it("縦書きでは、上下と左右が入れ替わる", () => {
    const block = pageAlignLabels("block", true);
    const inline = pageAlignLabels("inline", true);

    expect(block.axis).toBe("左右の寄せ");
    expect(block.options.map((choice) => choice.label)).toEqual([
      "右寄せ",
      "中央",
      "左寄せ",
    ]);
    expect(inline.axis).toBe("上下の寄せ");
    expect(inline.options.map((choice) => choice.label)).toEqual([
      "上寄せ",
      "中央",
      "下寄せ",
    ]);
  });

  /** 値そのものは入れ替わらない（入れ替わるのは呼び名だけ） */
  it("値は縦横で変わらない", () => {
    for (const vertical of [true, false]) {
      for (const axis of ["block", "inline"] as const) {
        expect(
          pageAlignLabels(axis, vertical).options.map((choice) => choice.value)
        ).toEqual(["start", "center", "end"]);
      }
    }
  });

  /**
   * 面の向き。**目次の面だけは、選んでも本の綴じ方向に従う**——目次で
   * 選んだ向きが変えるのは中の一覧だけで、寄せが効く面そのもの（見出しを
   * 含む枠）の向きは本のままだからである。
   */
  it("面の向きは、選んでいなければ本の綴じ方向に従う", () => {
    expect(pageLayoutVertical("colophon", undefined, true)).toBe(true);
    expect(
      pageLayoutVertical("colophon", { colophon: { vertical: false } }, true)
    ).toBe(false);
    expect(
      pageLayoutVertical("halfTitle", { halfTitle: { vertical: true } }, false)
    ).toBe(true);
    // 目次の面は本の綴じ方向のまま（横組みになるのは中の一覧だけ）
    expect(pageLayoutVertical("toc", { toc: { vertical: false } }, true)).toBe(
      true
    );
  });
});

describe("何も選んでいない面（回帰）", () => {
  it("既定の設計図には体裁の項目そのものが無い", () => {
    const config = defaultBookConfig("氷の街");
    expect(config.pageLayouts).toBeUndefined();
    // book.json にも書かれない（いままでの本のファイルが増えない）
    expect(JSON.stringify(config)).not.toContain("pageLayouts");
  });

  it("書いていない book.json を読んでも、体裁は付かない", () => {
    const parsed = parseBookConfig({ title: "氷の街" }, "氷の街");
    expect(parsed.pageLayouts).toBeUndefined();
  });

  it("CSSに体裁の行が1行も出ない", () => {
    const css = buildEpubCss(true);
    for (const type of PAGE_LAYOUT_BLOCK_TYPES) {
      expect(css).not.toContain(pageLayoutClass(type));
    }
    // 指定なしを渡しても同じもの（呼び方で中身が変わらない）
    expect(buildEpubCss(true, {}, {})).toBe(css);
  });

  it("何も選ばなければ、本のCSSは第1段のままである", () => {
    const files = open(buildEpub(book(defaultBookConfig("氷の街"))));
    expect(files["OEBPS/style.css"]).toBe(buildEpubCss(true));
  });

  /**
   * 面ごとのクラスは**選んだ面にしか付かない**。選んでいない面の断片は、
   * いままでと1バイトも変わらない。
   */
  it("面の断片にクラスが増えない", () => {
    expect(buildTitlePageFragment(defaultBookConfig("氷の街"))).toContain(
      '<div class="title-page">'
    );
    expect(buildColophonFragment(defaultBookConfig("氷の街"))).toContain(
      '<div class="colophon">'
    );
    expect(
      // 並べ方は既定の一覧で見る（`vertical` は0.55.xまでの綴りで、
      // いまは読み込みのときに `list` へ読み替えられる。設計書6.65.6）
      buildTocFragment([], { pattern: "list", ornament: "none" })
    ).toContain('<nav epub:type="toc" id="toc">');
    expect(buildCharacterPageFragment([])).toContain(
      '<section class="characters">'
    );
  });

  /** 本文の話には付けない（あとがきだけの印である） */
  it("本文の話にはあとがきの印が付かない", () => {
    const files = open(buildEpub(book(defaultBookConfig("氷の街"))));
    expect(files["OEBPS/chapter-001.xhtml"]).toContain(
      '<section class="chapter">'
    );
    expect(files["OEBPS/chapter-001.xhtml"]).not.toContain("page-afterword");
  });
});

describe("選んだ体裁が本へ出る", () => {
  const chosen = (): BookConfig => ({
    ...defaultBookConfig("氷の街"),
    pageLayouts: {
      colophon: { vertical: false, block: "end", inline: "center" },
      halfTitle: { block: "center" },
    },
  });

  it("CSSに、その面だけの向きと寄せが出る", () => {
    const css = buildEpubCss(true, {}, chosen().pageLayouts ?? {});

    expect(css).toContain(".page-colophon {");
    // 向きは古い書き方も並べる（縦書き・圏点と同じ理由）
    expect(css).toContain("  -epub-writing-mode: horizontal-tb;");
    expect(css).toContain("  writing-mode: horizontal-tb;");
    // 寄せは論理プロパティ（縦でも横でも同じ指定で効く）
    expect(css).toContain("  text-align: center;");
    expect(css).toContain("  justify-content: flex-end;");
    // 上下の寄せには面の高さが要る。**その面の文書だけ**へ与える
    expect(css).toContain("html.page-colophon, html.page-colophon body {");
    expect(css).toContain("  block-size: 100%;");
    // 選んでいない面の行は出ない
    expect(css).not.toContain(".page-toc {");
    expect(css).not.toContain(".page-characters {");
  });

  /** 本全体の綴じ方向（`html`）は触らない */
  it("本全体の向きは変えない", () => {
    const css = buildEpubCss(true, {}, chosen().pageLayouts ?? {});
    expect(css).toContain("html {\n  -epub-writing-mode: vertical-rl;");
  });

  it("寄せだけを選んだ面には、向きの行が出ない", () => {
    const css = buildEpubCss(true, {}, chosen().pageLayouts ?? {});
    const rule = css.slice(css.indexOf(".page-halfTitle {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).not.toContain("writing-mode");
    expect(body).toContain("justify-content: center;");
  });

  /** 選んだ面にだけクラスが付く（選んでいない面は素のまま） */
  it("選んだ面の断片にだけクラスが付く", () => {
    expect(buildTitlePageFragment(chosen())).toContain(
      '<div class="title-page page-halfTitle">'
    );
    expect(buildColophonFragment(chosen())).toContain(
      '<div class="colophon page-colophon">'
    );
    expect(
      buildTocFragment([], {
        // 見たいのは面のクラスなので、並べ方は既定の一覧でよい
        pattern: "list",
        ornament: "none",
        pageLayouts: chosen().pageLayouts,
      })
    ).toContain('<nav epub:type="toc" id="toc">');
    expect(
      buildCharacterPageFragment([], {
        characters: { inline: "center" },
      })
    ).toContain('<section class="characters page-characters">');
  });

  /**
   * 横組みにした面では、**縦中横を当てない**。縦書きのための細工なので、
   * 横組みの面に残ると1桁の数字だけが四角く潰れて出る。
   */
  it("横組みにした面では、数字を縦中横にしない", () => {
    const vertical = open(
      buildEpub(book({ ...defaultBookConfig("氷の街2"), blocks: undefined }))
    );
    // 縦組みの本の奥付では、いままでどおり縦中横が当たる
    expect(vertical["OEBPS/colophon.xhtml"]).toContain('class="tcy"');
    expect(vertical["OEBPS/colophon.xhtml"]).toContain('<body class="vertical">');

    const mixed = open(buildEpub(book({ ...chosen(), title: "氷の街2" })));
    expect(mixed["OEBPS/colophon.xhtml"]).not.toContain('class="tcy"');
    expect(mixed["OEBPS/colophon.xhtml"]).toContain('<body class="horizontal">');
    // 本文の面は本の綴じ方向のまま（面の指定は本文に及ばない）
    expect(mixed["OEBPS/chapter-001.xhtml"]).toContain(
      '<body class="vertical">'
    );
  });

  it("書き出した本のCSSと面のXHTMLに出る", () => {
    const files = open(buildEpub(book(chosen())));
    expect(files["OEBPS/style.css"]).toContain(".page-colophon {");
    // 高さを当てる手がかりは `<html>` に付く（その面の文書だけに効かせる）
    expect(files["OEBPS/colophon.xhtml"]).toContain('class="page-colophon"');
    expect(files["OEBPS/colophon.xhtml"]).toContain(
      'class="colophon page-colophon"'
    );
    // 本文の面には付かない
    expect(files["OEBPS/chapter-001.xhtml"]).not.toContain("page-colophon");
  });
});

describe("知らない値は落とす", () => {
  it("読めない寄せは、その軸だけを捨てる", () => {
    const parsed = parseBookConfig(
      {
        title: "氷の街",
        pageLayouts: {
          colophon: { block: "bottom", inline: "center" },
        },
      },
      "氷の街"
    );
    expect(parsed.pageLayouts?.colophon).toEqual({ inline: "center" });
  });

  it("知らない面・読めない形は捨てる", () => {
    const parsed = parseBookConfig(
      {
        title: "氷の街",
        pageLayouts: {
          cover: { block: "center" },
          body: { block: "center" },
          halfTitle: "中央",
          afterword: { vertical: "はい" },
        },
      },
      "氷の街"
    );
    // どれも残らないので、体裁の項目そのものが無くなる
    expect(parsed.pageLayouts).toBeUndefined();
  });

  /**
   * 目次の向きも、ほかの4面と**同じ欄**が持つ（作者の指摘、2026-09-13
   * 「目次のダブりも解消されてないです」）。以前は `tocPattern` が
   * 兼ねていたので、ここで落としていた。
   */
  it("目次の向きも受け取る", () => {
    const parsed = parseBookConfig(
      {
        title: "氷の街",
        pageLayouts: { toc: { vertical: false, inline: "end" } },
      },
      "氷の街"
    );
    expect(parsed.pageLayouts?.toc).toEqual({ vertical: false, inline: "end" });
  });

  it("空の指定は、項目ごと落とす", () => {
    const parsed = parseBookConfig(
      { title: "氷の街", pageLayouts: { colophon: {} } },
      "氷の街"
    );
    expect(parsed.pageLayouts).toBeUndefined();
  });
});

describe("画面の欄（5面すべてにある）", () => {
  const html = buildEpubEditorPanelHtml("NONCE123", "vscode-resource:");

  /** 面が増えたら落ちる（体裁を選べない面が黙って増えないように） */
  it("5つの面すべてに、寄せの欄が2つある", () => {
    expect(PAGE_LAYOUT_BLOCK_TYPES.length).toBe(5);
    for (const type of PAGE_LAYOUT_BLOCK_TYPES) {
      expect(html).toContain(`id="layout-${type}-block"`);
      expect(html).toContain(`id="layout-${type}-inline"`);
    }
  });

  /** 目次にも欄がある（向きの出どころは1つ。作者の指摘、2026-09-13） */
  it("縦横は3択で、5面すべてにある", () => {
    for (const type of PAGE_LAYOUT_BLOCK_TYPES) {
      expect(html).toContain(`id="layout-${type}-vertical"`);
    }
    expect(html).toContain('<option value="">本に従う</option>');
    expect(html).toContain('<option value="vertical">縦書き</option>');
    expect(html).toContain('<option value="horizontal">横書き</option>');
  });

  /** 呼び名は拡張機能側の表から届く（画面で書き写さない） */
  it("縦書きの呼び名も画面へ渡している", () => {
    expect(html).toContain('"label":"右寄せ"');
    expect(html).toContain('"label":"左寄せ"');
  });

  it("クラスの名前は1か所から作る", () => {
    expect(pageLayoutClass("afterword")).toBe("page-afterword");
  });
});
