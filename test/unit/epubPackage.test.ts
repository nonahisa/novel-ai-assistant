import { describe, expect, test } from "vitest";
import { unzipSync } from "fflate";
import {
  EPUB_MIMETYPE,
  buildEpub,
  imageMediaType,
  type EpubBook,
} from "../../src/core/epubPackage";
import { defaultBookConfig, type BookConfig } from "../../src/models/book";

/**
 * EPUB3のZIP組み立て（設計書6.65.4の第1段）。
 *
 * **開き直して確かめる。** 「組めた」と「リーダーが本として読める」は
 * 別のことなので、`unzipSync` で中身を取り出し、仕様の要になる箇所
 * （mimetypeの位置と無圧縮、container.xml の指す先、OPFのmanifest／spine）を
 * 見る。
 */

function book(overrides: Partial<EpubBook> = {}): EpubBook {
  return {
    config: defaultBookConfig("氷の街"),
    chapters: [
      { heading: "第一話　出会い", body: "あ\n\nい", notation: "curly" },
      { heading: "第二話　別れ", body: "う", notation: "curly" },
    ],
    cover: null,
    identifier: "urn:uuid:00000000-0000-4000-8000-000000000000",
    modified: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

function withConfig(patch: Partial<BookConfig>): EpubBook {
  return book({ config: { ...defaultBookConfig("氷の街"), ...patch } });
}

function open(zip: Uint8Array): Record<string, string> {
  const files = unzipSync(zip);
  const decoded: Record<string, string> = {};
  const decoder = new TextDecoder();
  for (const [name, bytes] of Object.entries(files)) {
    decoded[name] = decoder.decode(bytes);
  }
  return decoded;
}

/** ZIPの最初のローカルヘッダーを読む（先頭エントリの名前と圧縮方式） */
function firstEntry(zip: Uint8Array): {
  name: string;
  method: number;
  extraLength: number;
  content: string;
} {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50); // "PK\x03\x04"
  const method = view.getUint16(8, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const compressedSize = view.getUint32(18, true);
  const nameStart = 30;
  const contentStart = nameStart + nameLength + extraLength;
  const decoder = new TextDecoder();
  return {
    name: decoder.decode(zip.subarray(nameStart, nameStart + nameLength)),
    method,
    extraLength,
    content: decoder.decode(
      zip.subarray(contentStart, contentStart + compressedSize)
    ),
  };
}

describe("mimetype の置き方", () => {
  /**
   * **ここを外すとリーダーが本と認識しない。** EPUBの仕様で
   * 「先頭エントリ・無圧縮・拡張フィールドなし」と決まっている。
   */
  test("先頭エントリが mimetype で、無圧縮で入っている", () => {
    const entry = firstEntry(buildEpub(book()));

    expect(entry.name).toBe("mimetype");
    expect(entry.method).toBe(0); // 0 = 無圧縮（store）
    expect(entry.extraLength).toBe(0);
    expect(entry.content).toBe(EPUB_MIMETYPE);
  });

  test("開き直しても中身は application/epub+zip", () => {
    expect(open(buildEpub(book()))["mimetype"]).toBe(EPUB_MIMETYPE);
  });
});

describe("container.xml", () => {
  test("OPFの場所を指している", () => {
    const files = open(buildEpub(book()));
    const container = files["META-INF/container.xml"];

    expect(container).toContain('full-path="OEBPS/content.opf"');
    expect(container).toContain(
      'media-type="application/oebps-package+xml"'
    );
    expect(files["OEBPS/content.opf"]).toBeDefined();
  });
});

describe("content.opf", () => {
  test("書誌情報が dc: に載る", () => {
    const opf = open(
      buildEpub(
        withConfig({
          title: "氷の街",
          author: "野中",
          illustrator: "絵師",
          label: "○○文庫",
        })
      )
    )["OEBPS/content.opf"];

    expect(opf).toContain("<dc:title>氷の街</dc:title>");
    expect(opf).toContain("<dc:creator>野中</dc:creator>");
    expect(opf).toContain("絵師");
    expect(opf).toContain("<dc:publisher>○○文庫</dc:publisher>");
    expect(opf).toContain("<dc:language>ja</dc:language>");
    expect(opf).toContain(
      "<dc:identifier id=\"bookid\">urn:uuid:00000000-0000-4000-8000-000000000000</dc:identifier>"
    );
  });

  test("空の項目は要素ごと出さない（空の <dc:creator> を作らない）", () => {
    const opf = open(buildEpub(withConfig({ author: "", label: "" })))[
      "OEBPS/content.opf"
    ];

    expect(opf).not.toContain("<dc:creator>");
    expect(opf).not.toContain("<dc:publisher>");
  });

  test("全XHTMLとCSSが manifest に載る", () => {
    const files = open(buildEpub(book()));
    const opf = files["OEBPS/content.opf"];

    const inPackage = Object.keys(files).filter(
      (name) =>
        name.startsWith("OEBPS/") &&
        name !== "OEBPS/content.opf" &&
        (name.endsWith(".xhtml") || name.endsWith(".css"))
    );
    expect(inPackage.length).toBeGreaterThan(0);

    for (const name of inPackage) {
      // manifest の href は OPF から見た相対（OEBPS/ を外したもの）
      expect(opf, `${name} が manifest にない`).toContain(
        `href="${name.slice("OEBPS/".length)}"`
      );
    }
  });

  test("nav は properties=\"nav\" を持つ（EPUB3の決まり）", () => {
    const opf = open(buildEpub(book()))["OEBPS/content.opf"];
    expect(opf).toMatch(/<item[^>]*href="nav\.xhtml"[^>]*properties="nav"/);
  });

  test("縦書きなら spine が右→左", () => {
    const opf = open(buildEpub(withConfig({ writingMode: "vertical" })))[
      "OEBPS/content.opf"
    ];
    expect(opf).toContain('<spine page-progression-direction="rtl">');
  });

  test("横書きなら進行方向を書かない", () => {
    const opf = open(buildEpub(withConfig({ writingMode: "horizontal" })))[
      "OEBPS/content.opf"
    ];
    expect(opf).toContain("<spine>");
    expect(opf).not.toContain("page-progression-direction");
  });

  test("話は spine に順番どおり並ぶ", () => {
    const opf = open(buildEpub(book()))["OEBPS/content.opf"];
    const order = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(
      (match) => match[1]
    );

    expect(order.indexOf("chapter-001")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("chapter-001")).toBeLessThan(
      order.indexOf("chapter-002")
    );
    // 奥付は最後
    expect(order[order.length - 1]).toBe("colophon");
  });
});

describe("表紙", () => {
  test("画像があれば properties=\"cover-image\" で載る", () => {
    const files = open(
      buildEpub(
        book({
          cover: {
            fileName: "表紙.png",
            data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          },
        })
      )
    );
    const opf = files["OEBPS/content.opf"];

    expect(opf).toMatch(
      /<item[^>]*id="cover-image"[^>]*properties="cover-image"/
    );
    expect(opf).toContain('media-type="image/png"');
    // EPUB2しか読めないリーダー向けの目印も残す
    expect(opf).toContain('<meta name="cover" content="cover-image" />');
    expect(files["OEBPS/cover.png"]).toBeDefined();
    expect(files["OEBPS/cover.xhtml"]).toContain('src="cover.png"');
  });

  test("画像が無ければ題名と作者名の扉になる", () => {
    const files = open(buildEpub(withConfig({ author: "野中" })));

    expect(opfHas(files, "cover-image")).toBe(false);
    expect(files["OEBPS/cover.xhtml"]).toContain("氷の街");
    expect(files["OEBPS/cover.xhtml"]).toContain("野中");
    expect(files["OEBPS/cover.xhtml"]).not.toContain("<img");
  });

  function opfHas(files: Record<string, string>, id: string): boolean {
    return files["OEBPS/content.opf"].includes(`id="${id}"`);
  }
});

describe("目次（nav）", () => {
  test("話が順番どおり並ぶ", () => {
    const nav = open(buildEpub(book()))["OEBPS/nav.xhtml"];
    const links = [...nav.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)].map(
      (match) => match[2]
    );

    expect(links[0]).toBe("第一話　出会い");
    expect(links[1]).toBe("第二話　別れ");
  });

  test("tocEnabled が false でも nav は残す（EPUB3で必須）", () => {
    const files = open(buildEpub(withConfig({ tocEnabled: false })));

    expect(files["OEBPS/nav.xhtml"]).toBeDefined();
    expect(files["OEBPS/content.opf"]).toMatch(
      /<item[^>]*properties="nav"/
    );
    // 読み物としての目次ページだけを外す
    expect(files["OEBPS/content.opf"]).not.toContain('<itemref idref="nav"');
  });

  test("tocEnabled が true なら読む面にも出す", () => {
    const opf = open(buildEpub(withConfig({ tocEnabled: true })))[
      "OEBPS/content.opf"
    ];
    expect(opf).toContain('<itemref idref="nav"');
  });
});

describe("本文と体裁", () => {
  test("話ごとに1つのXHTMLになる", () => {
    const files = open(buildEpub(book()));

    expect(files["OEBPS/chapter-001.xhtml"]).toContain("第一話　出会い");
    expect(files["OEBPS/chapter-002.xhtml"]).toContain("第二話　別れ");
    expect(files["OEBPS/chapter-003.xhtml"]).toBeUndefined();
  });

  test("縦書きのCSSは writing-mode: vertical-rl", () => {
    const css = open(buildEpub(withConfig({ writingMode: "vertical" })))[
      "OEBPS/style.css"
    ];
    expect(css).toContain("writing-mode: vertical-rl");
    expect(css).toContain("text-orientation: mixed");
  });

  test("横書きのCSSは縦書きにしない", () => {
    const css = open(buildEpub(withConfig({ writingMode: "horizontal" })))[
      "OEBPS/style.css"
    ];
    expect(css).toContain("writing-mode: horizontal-tb");
    expect(css).not.toContain("vertical-rl");
  });

  test("奥付には書誌情報が載る", () => {
    const colophon = open(
      buildEpub(withConfig({ author: "野中", label: "○○文庫" }))
    )["OEBPS/colophon.xhtml"];

    expect(colophon).toContain("氷の街");
    expect(colophon).toContain("野中");
    expect(colophon).toContain("○○文庫");
  });

  test("話が1つも無ければ組まない", () => {
    expect(() => buildEpub(book({ chapters: [] }))).toThrow();
  });
});

describe("表紙画像の種類", () => {
  test("拡張子から判定する", () => {
    expect(imageMediaType("表紙.png")).toBe("image/png");
    expect(imageMediaType("表紙.JPG")).toBe("image/jpeg");
    expect(imageMediaType("表紙.jpeg")).toBe("image/jpeg");
    expect(imageMediaType("表紙.webp")).toBe("image/webp");
  });

  test("扱えない種類は、分かる言葉で断る", () => {
    expect(() => imageMediaType("表紙.bmp")).toThrow(/bmp/);
    expect(() => imageMediaType("表紙")).toThrow();
  });
});
