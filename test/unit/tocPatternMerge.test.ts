import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import {
  defaultBookBlocks,
  defaultBookConfig,
  parseBookConfig,
  type BookConfig,
} from "../../src/models/book";
import { buildEpub, type EpubBook } from "../../src/core/epubPackage";
import { buildEpubEditorPanelHtml } from "../../src/views/epubEditorPanelHtml";

/**
 * 目次の「並べ方」と「文字の向き」の重複を潰した（作者の指摘、2026-09-13
 * 「目次のダブりも解消されてないです」）。
 *
 * 旧 `tocPattern` は `vertical`／`horizontal`／`chapters` の3択で、前の2つは
 * **並べ方が同じで向きだけが違った**。面ごとの「文字の向き」の欄ができた
 * ことで、目次だけ向きの出どころが2つになっていた。並べ方は `list`／
 * `chapters` の2択にし、向きは5面とも `pageLayouts.*.vertical` が持つ。
 *
 * **ここで見るのは2つ。** 古い設計図が正しく読み替わることと、
 * **既にある本のZIPが1バイトも変わらない**ことである。
 */

function make(raw: Record<string, unknown>, grouped = false): EpubBook {
  const config = parseBookConfig({ title: "氷の街", ...raw }, "氷の街");
  return book({ ...config, blocks: defaultBookBlocks(config) }, grouped);
}

function book(config: BookConfig, grouped: boolean): EpubBook {
  // 章で束ねるには**束ね名が要る**（無ければ一覧のまま出す。設計書6.65.6）
  const group = grouped ? "本編" : undefined;
  return {
    config,
    chapters: [
      { heading: "第一話　出会い", body: "あ\n\nい", notation: "curly", group },
      { heading: "第二話　別れ", body: "う", notation: "curly", group },
    ],
    cover: null,
    backCover: null,
    // 書き出すたびに変わる2つは固定する（中身を突き合わせるため）
    identifier: "urn:uuid:00000000-0000-4000-8000-000000000000",
    modified: "2026-09-03T00:00:00Z",
  };
}

function files(
  raw: Record<string, unknown>,
  grouped = false
): Record<string, string> {
  const decoder = new TextDecoder();
  const out: Record<string, string> = {};
  const zip = unzipSync(buildEpub(make(raw, grouped)));
  for (const [name, bytes] of Object.entries(zip)) {
    out[name] = decoder.decode(bytes);
  }
  return out;
}

function digests(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(unzipSync(buildEpub(make(raw))))) {
    out[name] = createHash("sha256").update(bytes).digest("hex");
  }
  return out;
}

describe("古い設計図の読み替え", () => {
  it("「目次だけ横組み」は、一覧＋横書きになる", () => {
    const config = parseBookConfig(
      { title: "氷の街", tocPattern: "horizontal" },
      "氷の街"
    );

    expect(config.tocPattern).toBe("list");
    expect(config.pageLayouts?.toc).toEqual({ vertical: false });
  });

  /**
   * **作者の選択が勝つ。** 読み替えは古い設計図を今の形で読むためのもので
   * あって、作者が選んだ向きを上書きする権限は無い。
   */
  it("向きを既に選んでいたら、読み替えは上書きしない", () => {
    const config = parseBookConfig(
      {
        title: "氷の街",
        tocPattern: "horizontal",
        pageLayouts: { toc: { vertical: true } },
      },
      "氷の街"
    );

    expect(config.tocPattern).toBe("list");
    expect(config.pageLayouts?.toc).toEqual({ vertical: true });
  });

  /** ほかの軸（寄せ）を消さずに、向きだけを足す */
  it("寄せだけ選んでいたら、向きを足して寄せは残す", () => {
    const config = parseBookConfig(
      {
        title: "氷の街",
        tocPattern: "horizontal",
        pageLayouts: { toc: { inline: "end" } },
      },
      "氷の街"
    );

    expect(config.pageLayouts?.toc).toEqual({ inline: "end", vertical: false });
  });

  /**
   * 旧 `vertical` は「必ず縦組み」ではなく**本文と同じ流れ**だった
   * （0.29.18で決めた）。向きを入れると、横組みの本で目次だけ縦になる。
   */
  it("「本文と同じ流れ」は、向きを触らずに一覧へ読み替わる", () => {
    const config = parseBookConfig(
      { title: "氷の街", tocPattern: "vertical" },
      "氷の街"
    );

    expect(config.tocPattern).toBe("list");
    expect(config.pageLayouts).toBeUndefined();
  });

  it("章ごとは、向きを触らずにそのまま", () => {
    const config = parseBookConfig(
      { title: "氷の街", tocPattern: "chapters" },
      "氷の街"
    );

    expect(config.tocPattern).toBe("chapters");
    expect(config.pageLayouts).toBeUndefined();
  });

  it("書いていなければ既定（一覧）に落ちる", () => {
    expect(parseBookConfig({ title: "氷の街" }, "氷の街").tocPattern).toBe(
      "list"
    );
    expect(defaultBookConfig("氷の街").tocPattern).toBe("list");
  });

  /**
   * **知らない綴りは、いままでどおり断る**（設計書6.65.2の約束）。
   * 黙って既定へ倒すと、作者は「指定が効いていない」ことに気づけない。
   */
  it("知らない綴りは断る", () => {
    expect(() =>
      parseBookConfig({ title: "氷の街", tocPattern: "たて組み" }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ title: "氷の街", tocPattern: "list-horizontal" }, "氷の街")
    ).toThrow();
  });

  /** 読み替えたものを読み直しても同じ（保存して開き直しても動かない） */
  it("読み替えたあとの設計図を読み直しても変わらない", () => {
    const once = parseBookConfig(
      { title: "氷の街", tocPattern: "horizontal" },
      "氷の街"
    );
    const twice = parseBookConfig(
      JSON.parse(JSON.stringify(once)) as unknown,
      "氷の街"
    );

    expect(twice.tocPattern).toBe("list");
    expect(twice.pageLayouts?.toc).toEqual({ vertical: false });
  });
});

describe("画面の欄", () => {
  const html = buildEpubEditorPanelHtml("NONCE123", "vscode-resource:");

  /**
   * **並べ方の欄に向きの言葉を出さない。** 出すと、下の「文字の向き」と
   * どちらが効いているのか作者に分からなくなる（重複そのもの）。
   */
  it("並べ方は2択で、向きの言葉を含まない", () => {
    const select = /<select id="tocPattern">([\s\S]*?)<\/select>/.exec(html);
    expect(select).not.toBeNull();
    const body = select?.[1] ?? "";

    expect([...body.matchAll(/<option /g)]).toHaveLength(2);
    expect(body).toContain('value="list"');
    expect(body).toContain('value="chapters"');
    expect(body).not.toContain("横組み");
    expect(body).not.toContain("縦組み");
    expect(body).not.toContain("横書き");
    expect(body).not.toContain("縦書き");
  });

  /** 逃げの注記（向きは並べ方で選ぶ、という案内）を消したこと */
  it("目次にも文字の向きの欄があり、逃げの注記が無い", () => {
    expect(html).toContain('id="layout-toc-vertical"');
    expect(html).not.toContain("上の「並べ方」で選びます");
  });
});

describe("書き出し", () => {
  it("横書きを選ぶと、一覧に toc-horizontal が付く", () => {
    const out = files({ tocPattern: "horizontal" });

    expect(out["OEBPS/nav.xhtml"]).toContain('class="nav-list toc-horizontal"');
  });

  /**
   * **面ぜんぶの向きは出さない**（`PAGE_LAYOUT_LIST_ONLY_ORIENTATION`）。
   * 出すと見出し（`<nav>` 全体）まで横になり、「目次だけ横組み」を選んで
   * いた既にある本の見た目が変わる。
   */
  it("面ぜんぶの writing-mode は出さない", () => {
    const out = files({ tocPattern: "horizontal" });

    // `<html>` にも `<nav>` にも、面の体裁の印は付かない
    expect(out["OEBPS/nav.xhtml"]).not.toContain("page-toc");
    expect(out["OEBPS/style.css"]).not.toContain(".page-toc");
    // 面の向きは本のまま（縦組みの本なので縦のまま）
    expect(out["OEBPS/nav.xhtml"]).toContain('<body class="vertical">');
  });

  /** 寄せは出してよい（効くのは面そのもの＝本の綴じ方向の中である） */
  it("寄せを選べば、目次にも面の体裁が当たる", () => {
    const out = files({
      tocPattern: "horizontal",
      pageLayouts: { toc: { vertical: false, inline: "center" } },
    });

    expect(out["OEBPS/nav.xhtml"]).toContain('class="page-toc"');
    // 寄せを選んでも、`.page-toc` に向きの指定は入らない
    const rule = /\.page-toc \{([^}]*)\}/.exec(out["OEBPS/style.css"] ?? "");
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain("text-align: center;");
    expect(rule?.[1]).not.toContain("writing-mode");
    // 一覧の横組みは、いままでどおり `toc-horizontal` が持つ
    expect(out["OEBPS/nav.xhtml"]).toContain("toc-horizontal");
  });

  /**
   * **重複を潰したことで増えた自由**（退化ではない）。旧3択では
   * 「章ごと」と「横組み」を同時に選べなかった。
   */
  it("章ごと＋横書きが選べる", () => {
    const out = files(
      {
        tocPattern: "chapters",
        pageLayouts: { toc: { vertical: false } },
      },
      true
    );

    expect(out["OEBPS/nav.xhtml"]).toContain(
      'class="nav-list toc-chapters toc-horizontal"'
    );
  });

  /**
   * 縦組みの指定は**選んだときだけ**CSSへ出す。横組み（`.toc-horizontal`）
   * は0.29.18からどの本にも入っているが、縦組みの行はどの本にも無かった
   * ——常に出すと、選んでいない本のCSSが版を上げただけで増える。
   */
  it("縦書きを選んだときだけ、縦組みの規則が出る", () => {
    const chosen = files({
      tocPattern: "list",
      pageLayouts: { toc: { vertical: true } },
    });
    expect(chosen["OEBPS/nav.xhtml"]).toContain('class="nav-list toc-vertical-rl"');
    expect(chosen["OEBPS/style.css"]).toContain(".toc-vertical-rl {");

    const plain = files({ tocPattern: "list" });
    expect(plain["OEBPS/style.css"]).not.toContain("toc-vertical-rl");
    // 選んでいない本は、いままでどおりの印だけ
    expect(plain["OEBPS/nav.xhtml"]).toContain('class="nav-list toc-vertical"');
  });
});

/**
 * **既にある本のZIPが1バイトも変わらない**（回帰の固定）。
 *
 * 下のハッシュは、重複を潰す**前**の書き出しから採った（2026-09-13）。
 * `content.opf` は本を見分ける札と時刻を固定してあるので、ここでは
 * 目次（`nav.xhtml`）と体裁（`style.css`）だけを見る——この作業で
 * 変わりうるのはその2つだけである。
 *
 * **ここを更新してよいのは、本の見た目を変えると決めたときだけ**である。
 */
describe("既にある本は変わらない（回帰の固定）", () => {
  const BEFORE: Record<string, { nav: string; css: string }> = {
    "縦組みの本・目次だけ横組み": {
      nav: "4843ec691ada64f86573c4f54d0fd926daf7a04122839a9dcce0f257e64e299b",
      css: "f311500002027ae65542018dc766b5898c69eaec63a8f3b8acfae9f41c485ac9",
    },
    "縦組みの本・本文と同じ流れ": {
      nav: "0cd8292838f91c840262d49771872bc363e15097aa2ca6936525c25304e5c918",
      css: "f311500002027ae65542018dc766b5898c69eaec63a8f3b8acfae9f41c485ac9",
    },
    "縦組みの本・章ごと": {
      nav: "0cd8292838f91c840262d49771872bc363e15097aa2ca6936525c25304e5c918",
      css: "f311500002027ae65542018dc766b5898c69eaec63a8f3b8acfae9f41c485ac9",
    },
    // **横組みの本で「本文と同じ流れ」**が、いちばん壊しやすい組み合わせ
    // である。読み替えで向きを入れてしまうと、目次だけ横組みの印が付く
    "横組みの本・本文と同じ流れ": {
      nav: "0a38fcf0c5d6ad5f6256df1492425fea06a1cb411aa7e05a71d8bf9f1431c853",
      css: "fdddb4213849559872433ed3a6d33ea47c49768bedd8f3279fe6a36cdb1b7c15",
    },
    "横組みの本・目次だけ横組み": {
      nav: "340b1327e6be8cbcbd35debea0b4396d42845365ba3e9cfa34e6f5e72f789dbd",
      css: "fdddb4213849559872433ed3a6d33ea47c49768bedd8f3279fe6a36cdb1b7c15",
    },
    "何も書いていない設計図": {
      nav: "0cd8292838f91c840262d49771872bc363e15097aa2ca6936525c25304e5c918",
      css: "f311500002027ae65542018dc766b5898c69eaec63a8f3b8acfae9f41c485ac9",
    },
  };

  const CASES: Record<string, Record<string, unknown>> = {
    "縦組みの本・目次だけ横組み": { tocPattern: "horizontal" },
    "縦組みの本・本文と同じ流れ": { tocPattern: "vertical" },
    "縦組みの本・章ごと": { tocPattern: "chapters" },
    "横組みの本・本文と同じ流れ": {
      tocPattern: "vertical",
      writingMode: "horizontal",
    },
    "横組みの本・目次だけ横組み": {
      tocPattern: "horizontal",
      writingMode: "horizontal",
    },
    "何も書いていない設計図": {},
  };

  for (const [name, raw] of Object.entries(CASES)) {
    it(`${name}：目次と体裁が同じ`, () => {
      const out = digests(raw);
      expect({
        nav: out["OEBPS/nav.xhtml"],
        css: out["OEBPS/style.css"],
      }).toEqual(BEFORE[name]);
    });
  }
});
