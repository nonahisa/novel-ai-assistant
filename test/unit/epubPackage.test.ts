import { describe, expect, test } from "vitest";
import { unzipSync } from "fflate";
import {
  EPUB_MIMETYPE,
  buildColophonFragment,
  buildCoverFragment,
  buildEpub,
  buildEpubCss,
  buildTitlePageFragment,
  buildTocFragment,
  fontMediaType,
  imageMediaType,
  scopeCssForPreview,
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
    backCover: null,
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

/**
 * 裏表紙（設計書6.65.8）。
 *
 * **本の最終面**である（奥付の後ろ）。焼いた画像が無ければ面ごと出さない
 * ——空の裏表紙が1面挟まるより、無いほうがよい。
 */
describe("裏表紙", () => {
  const backCover = {
    fileName: "裏表紙_合成済み.png",
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };

  test("画像があれば、奥付の後ろの最終面になる", () => {
    const files = open(buildEpub(book({ backCover })));
    const opf = files["OEBPS/content.opf"];
    const order = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(
      (match) => match[1]
    );

    expect(order[order.length - 1]).toBe("backcover");
    expect(order[order.length - 2]).toBe("colophon");
    expect(files["OEBPS/backcover.xhtml"]).toContain('src="backcover.png"');
    expect(files["OEBPS/backcover.png"]).toBeDefined();
  });

  test("manifest に載る。ただし cover-image の印は表紙だけが持つ", () => {
    const opf = open(
      buildEpub(
        book({
          cover: { fileName: "表紙.png", data: new Uint8Array([0x89]) },
          backCover,
        })
      )
    )["OEBPS/content.opf"];

    expect(opf).toContain('id="backcover-image"');
    // `cover-image` は本に1つだけ。裏表紙にも付けると検証で落ちる
    expect([...opf.matchAll(/properties="cover-image"/g)].length).toBe(1);
  });

  test("画像が無ければ、面そのものが無い", () => {
    const files = open(buildEpub(book()));

    expect(files["OEBPS/backcover.xhtml"]).toBeUndefined();
    expect(files["OEBPS/content.opf"]).not.toContain("backcover");
  });

  test("焼いていない元イラスト（PNG以外）でも最終面に載る", () => {
    // 合成していない裏表紙も本へ入る。**表紙と同じ拾い方**なので、
    // 種類はPNGとは限らない
    const files = open(
      buildEpub(
        book({
          backCover: {
            fileName: "素材/裏表紙.jpg",
            data: new Uint8Array([0xff, 0xd8]),
          },
        })
      )
    );

    expect(files["OEBPS/backcover.jpg"]).toBeDefined();
    expect(files["OEBPS/content.opf"]).toContain('media-type="image/jpeg"');
    expect(files["OEBPS/backcover.xhtml"]).toContain('src="backcover.jpg"');
  });
});

/**
 * 挿絵（設計書6.65.10）。
 *
 * 本文の流れに `<figure>` で入れる。**ZIPの中の名前は機械名に付け替える**
 * ——表紙と同じ理由で、空白や日本語のファイル名だと画像を出さない
 * リーダーがある。
 */
describe("挿絵", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  function illustrated(): EpubBook {
    return book({
      chapters: [
        {
          heading: "第一話　出会い",
          body: "あ\n\nい",
          notation: "curly",
          illustrations: [
            {
              afterParagraph: 1,
              sourcePath: "素材/挿絵 1.png",
              data: png,
              caption: "出会いの場面",
            },
          ],
        },
        {
          heading: "第二話　別れ",
          body: "う",
          notation: "curly",
          // 同じ画像を2か所で使う。ZIPには1回だけ入る
          illustrations: [
            {
              afterParagraph: 1,
              sourcePath: "素材/挿絵 1.png",
              data: png,
              caption: "",
            },
            {
              afterParagraph: 1,
              sourcePath: "素材/挿絵2.jpg",
              data: new Uint8Array([0xff, 0xd8]),
              caption: "",
            },
          ],
        },
      ],
    });
  }

  test("画像は機械名でZIPへ入り、manifest に載る", () => {
    const files = open(buildEpub(illustrated()));
    const opf = files["OEBPS/content.opf"];

    expect(files["OEBPS/illust-1.png"]).toBeDefined();
    expect(files["OEBPS/illust-2.jpg"]).toBeDefined();
    // 作者のファイル名（空白・日本語）はZIPの中に持ち込まない
    expect(files["OEBPS/素材/挿絵 1.png"]).toBeUndefined();
    expect(opf).toMatch(
      /<item[^>]*id="illust-1"[^>]*href="illust-1\.png"[^>]*media-type="image\/png"/
    );
    expect(opf).toMatch(/<item[^>]*href="illust-2\.jpg"/);
    // 表紙ではないので `cover-image` は付けない
    expect([...opf.matchAll(/properties="cover-image"/g)].length).toBe(0);
  });

  test("同じ画像を2か所で使っても、入るのは1回だけ", () => {
    const files = open(buildEpub(illustrated()));

    expect(
      Object.keys(files).filter((name) => name.startsWith("OEBPS/illust-"))
    ).toEqual(["OEBPS/illust-1.png", "OEBPS/illust-2.jpg"]);
    // 2話目も同じ画像を指す
    expect(files["OEBPS/chapter-002.xhtml"]).toContain('src="illust-1.png"');
  });

  test("本文の指定した段落の直後に入り、解説文が添う", () => {
    const files = open(buildEpub(illustrated()));
    const chapter = files["OEBPS/chapter-001.xhtml"];

    expect(chapter).toMatch(/<p>あ<\/p>\n<figure class="illustration">/);
    expect(chapter).toContain("<figcaption>出会いの場面</figcaption>");
    expect(files["OEBPS/style.css"]).toContain(".illustration");
  });

  test("改ページは次の段落のクラスになる（XHTMLは分けない）", () => {
    const files = open(
      buildEpub(
        book({
          chapters: [
            {
              heading: "第一話",
              body: "あ\n\nい",
              notation: "curly",
              pageBreaks: [1],
            },
          ],
        })
      )
    );

    expect(files["OEBPS/chapter-001.xhtml"]).toContain(
      '<p class="page-break">い</p>'
    );
    // 古いリーダー用の書き方も並べる
    expect(files["OEBPS/style.css"]).toContain("page-break-before: always");
    expect(files["OEBPS/style.css"]).toContain("break-before: page");
  });

  test("扱えない種類は、分かる言葉で断る", () => {
    expect(() =>
      buildEpub(
        book({
          chapters: [
            {
              heading: "第一話",
              body: "あ",
              notation: "curly",
              illustrations: [
                {
                  afterParagraph: 1,
                  sourcePath: "素材/挿絵.bmp",
                  data: png,
                  caption: "",
                },
              ],
            },
          ],
        })
      )
    ).toThrow(/bmp/);
  });

  test("挿絵が無ければ、いままでと同じ本になる", () => {
    const files = open(buildEpub(book()));
    expect(
      Object.keys(files).filter((name) => name.includes("illust"))
    ).toEqual([]);
    expect(files["OEBPS/chapter-001.xhtml"]).not.toContain("figure");
  });
});

describe("タイトルページ（扉）", () => {
  /**
   * 表紙とは別の1面である（設計書6.65.3の表）。表紙が画像1枚のとき、
   * 題名や作者名を読む場所がここになる。
   */
  test("表紙の直後・目次の前に置く", () => {
    const opf = open(buildEpub(book()))["OEBPS/content.opf"];
    const order = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(
      (match) => match[1]
    );

    expect(order[0]).toBe("cover");
    expect(order[1]).toBe("titlepage");
    expect(order[2]).toBe("nav");
    expect(order[3]).toBe("chapter-001");
  });

  test("目次ページを外しても、扉は残る", () => {
    const opf = open(buildEpub(withConfig({ tocEnabled: false })))[
      "OEBPS/content.opf"
    ];
    const order = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(
      (match) => match[1]
    );

    expect(order[0]).toBe("cover");
    expect(order[1]).toBe("titlepage");
    expect(order[2]).toBe("chapter-001");
  });

  test("manifest に載る（載せ忘れると本の中に無いのと同じ）", () => {
    const files = open(buildEpub(book()));

    expect(files["OEBPS/titlepage.xhtml"]).toBeDefined();
    expect(files["OEBPS/content.opf"]).toMatch(
      /<item[^>]*id="titlepage"[^>]*href="titlepage\.xhtml"/
    );
  });

  test("書誌情報が並ぶ。空の項目は出さない", () => {
    const withAll = open(
      buildEpub(
        withConfig({ author: "野中", illustrator: "絵師", label: "○○文庫" })
      )
    )["OEBPS/titlepage.xhtml"];

    expect(withAll).toContain("氷の街");
    expect(withAll).toContain("野中");
    expect(withAll).toContain("絵師");
    expect(withAll).toContain("○○文庫");

    const bare = open(buildEpub(withConfig({ author: "", label: "" })))[
      "OEBPS/titlepage.xhtml"
    ];
    expect(bare).toContain("氷の街");
    expect(bare).not.toContain("book-author");
    expect(bare).not.toContain("book-label");
  });

  test("扉の断片は、プレビューへ渡すものと同じ", () => {
    const config = { ...defaultBookConfig("氷の街"), author: "野中" };
    expect(open(buildEpub({ ...book(), config }))["OEBPS/titlepage.xhtml"]).toContain(
      buildTitlePageFragment(config)
    );
  });
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

describe("目次の見出しの形（設計書6.65.15）", () => {
  /** 番号と題を別々に持つ話（`features/exportEpub.ts` が渡す形） */
  function withEntries(): EpubBook {
    return book({
      chapters: [
        {
          heading: "第1話　出会い",
          numberLabel: "第1話",
          title: "出会い",
          body: "あ",
          notation: "curly",
        },
        {
          heading: "第2話　別れ",
          numberLabel: "第2話",
          title: "別れ",
          body: "い",
          notation: "curly",
        },
      ],
    });
  }

  function tocLabels(config: Partial<BookConfig> = {}): string[] {
    // **横書きに固定する。** 縦中横（設計書6.65.15の2）は別のdescribeで見る
    // ——番号に含まれる数字が `<span class="tcy">` で割れると、ここで見たい
    // 「番号＋題の組み方」の比較がしづらくなる
    const nav = open(
      buildEpub({
        ...withEntries(),
        config: {
          ...defaultBookConfig("氷の街"),
          writingMode: "horizontal",
          ...config,
        },
      })
    )["OEBPS/nav.xhtml"];
    return [
      ...nav.matchAll(/<a href="chapter-\d+\.xhtml">([^<]*)<\/a>/g),
    ].map((match) => match[1]);
  }

  test("既定（numberAndTitle）は番号＋題で、いままでどおりの見た目", () => {
    expect(tocLabels()).toEqual(["第1話　出会い", "第2話　別れ"]);
  });

  test("titleOnly は題だけ", () => {
    expect(tocLabels({ tocEntryStyle: "titleOnly" })).toEqual([
      "出会い",
      "別れ",
    ]);
  });

  test("numberOnly は番号だけ", () => {
    expect(tocLabels({ tocEntryStyle: "numberOnly" })).toEqual([
      "第1話",
      "第2話",
    ]);
  });

  test("番号・題を持たない話（呼び出し側が heading だけ渡す形）は heading のまま", () => {
    // `book()` の既定チャプターは numberLabel・title を持たない
    const nav = open(
      buildEpub(withConfig({ tocEntryStyle: "titleOnly" }))
    )["OEBPS/nav.xhtml"];
    expect(nav).toContain("第一話　出会い");
  });
});

describe("半角の縦中横（設計書6.65.15）", () => {
  function verticalBook(): EpubBook {
    return book({
      config: {
        ...defaultBookConfig("氷の街"),
        writingMode: "vertical",
        author: "野中1号",
      },
      chapters: [{ heading: "第1話　出会い", body: "あ", notation: "curly" }],
    });
  }

  function horizontalBook(): EpubBook {
    return book({
      config: {
        ...defaultBookConfig("氷の街"),
        writingMode: "horizontal",
        author: "野中1号",
      },
      chapters: [{ heading: "第1話　出会い", body: "あ", notation: "curly" }],
    });
  }

  test("CSSに3種の書き方が並ぶ", () => {
    const css = open(buildEpub(book()))["OEBPS/style.css"];
    expect(css).toContain("text-combine-upright: all");
    expect(css).toContain("-webkit-text-combine: horizontal");
    expect(css).toContain("-epub-text-combine: horizontal");
  });

  test("縦書きの目次・見出し・奥付では数字が tcy で包まれる", () => {
    const files = open(buildEpub(verticalBook()));
    expect(files["OEBPS/nav.xhtml"]).toContain('<span class="tcy">1</span>');
    expect(files["OEBPS/chapter-001.xhtml"]).toContain(
      '<span class="tcy">1</span>'
    );
    expect(files["OEBPS/colophon.xhtml"]).toContain(
      '<span class="tcy">1</span>'
    );
  });

  test("横書きでは包まない", () => {
    const files = open(buildEpub(horizontalBook()));
    expect(files["OEBPS/nav.xhtml"]).not.toContain('class="tcy"');
    expect(files["OEBPS/chapter-001.xhtml"]).not.toContain('class="tcy"');
    expect(files["OEBPS/colophon.xhtml"]).not.toContain('class="tcy"');
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

describe("目次の配置パターン（設計書6.65.6）", () => {
  /** 章で束ねられる材料。プロローグ・本編・幕間が混ざった本 */
  function grouped(): EpubBook {
    return book({
      chapters: [
        { heading: "プロローグ", body: "あ", notation: "curly", group: "プロローグ" },
        { heading: "第一話　出会い", body: "い", notation: "curly", group: "本編" },
        { heading: "幕間1", body: "う", notation: "curly", group: "幕間" },
      ],
    });
  }

  test("既定は本文と同じ流れの一覧（いままでどおり）", () => {
    const nav = open(buildEpub(book()))["OEBPS/nav.xhtml"];

    expect(nav).toContain('class="nav-list toc-vertical"');
    expect(nav).not.toContain("toc-group");
  });

  test("横組みの一覧は、目次だけ横組みにする", () => {
    const files = open(buildEpub(withConfig({ tocPattern: "horizontal" })));

    expect(files["OEBPS/nav.xhtml"]).toContain('class="nav-list toc-horizontal"');
    // 見た目を決めるのはCSS。断片の目印とCSSが揃っていないと効かない
    expect(files["OEBPS/style.css"]).toContain(".toc-horizontal");
  });

  test("章ごとに区切ると、章の見出しが出る", () => {
    const nav = open(buildEpub(grouped()))["OEBPS/nav.xhtml"];
    expect(nav).not.toContain("toc-group");

    const chaptered = open(
      buildEpub({
        ...grouped(),
        config: { ...defaultBookConfig("氷の街"), tocPattern: "chapters" },
      })
    )["OEBPS/nav.xhtml"];

    expect(chaptered).toContain('class="toc-group"');
    expect(chaptered).toContain(">プロローグ<");
    expect(chaptered).toContain(">本編<");
    expect(chaptered).toContain(">幕間<");
    // 話は消えない。束ねるだけである
    expect(chaptered).toContain("第一話　出会い");
  });

  test("章ごとでも、束ねる名前が無ければ一覧のまま", () => {
    // `group` を持たない材料（合本や日付だけのファイル）で見出しを捏造しない
    const nav = open(
      buildEpub(withConfig({ tocPattern: "chapters" }))
    )["OEBPS/nav.xhtml"];

    expect(nav).not.toContain("toc-group");
    expect(nav).toContain("第一話　出会い");
  });

  /**
   * **束ね名が読めないものは束ねない**（設計書6.65.6）。
   *
   * 束ねられる話と束ねられない話が混ざる作品（本編＋名前だけのファイル）で、
   * 読めないほうまで章に包むと**名前の無い章の見出し**が立つ。作者が
   * 書いていない構成が本に載るのは、章を捏造するのと同じである。
   */
  test("束ね名の無い話は、章に包まず一覧の項目として置く", () => {
    const nav = open(
      buildEpub({
        ...book({
          chapters: [
            { heading: "第一話　出会い", body: "あ", notation: "curly", group: "本編" },
            // 話数も種別も読めないファイル。`episodeGroupLabel` は空を返す
            { heading: "あとがき", body: "い", notation: "curly", group: "" },
            { heading: "第二話　別れ", body: "う", notation: "curly", group: "本編" },
          ],
        }),
        config: { ...defaultBookConfig("氷の街"), tocPattern: "chapters" },
      })
    )["OEBPS/nav.xhtml"];

    // 空の見出しを立てない
    expect(nav).not.toContain('<span class="toc-group"></span>');
    expect([...nav.matchAll(/<span class="toc-group">/g)]).toHaveLength(2);
    // 束ねられない話も、消さずに一覧の項目として置く
    expect(nav).toContain("あとがき");
    // 並びは本の順のまま（並べ替えない）
    expect(nav.indexOf("第一話")).toBeLessThan(nav.indexOf("あとがき"));
    expect(nav.indexOf("あとがき")).toBeLessThan(nav.indexOf("第二話"));
  });

  test("束ね名が全部読めなければ、章の見出しは1つも立たない", () => {
    const nav = open(
      buildEpub({
        ...book({
          chapters: [
            { heading: "前編", body: "あ", notation: "curly", group: "  " },
            { heading: "後編", body: "い", notation: "curly" },
          ],
        }),
        config: { ...defaultBookConfig("氷の街"), tocPattern: "chapters" },
      })
    )["OEBPS/nav.xhtml"];

    expect(nav).not.toContain("toc-group");
    expect(nav).toContain("前編");
    expect(nav).toContain("後編");
  });
});

describe("目次と奥付の飾り（設計書6.65.6）", () => {
  test("「なし」では飾りが出ない", () => {
    const files = open(buildEpub(book()));

    expect(files["OEBPS/nav.xhtml"]).not.toContain("ornament");
    expect(files["OEBPS/colophon.xhtml"]).not.toContain("ornament");
  });

  test("罫線はCSSで引く（外部ファイルを増やさない）", () => {
    const files = open(
      buildEpub(withConfig({ tocOrnament: "rule", colophonOrnament: "rule" }))
    );

    expect(files["OEBPS/nav.xhtml"]).toContain("ornament-rule");
    expect(files["OEBPS/colophon.xhtml"]).toContain("ornament-rule");
    expect(files["OEBPS/style.css"]).toContain(".ornament-rule");
    // 画像ファイルは増やさない
    expect(Object.keys(files).filter((name) => name.endsWith(".svg"))).toEqual([]);
  });

  test("中央飾りは断片の中のSVG", () => {
    const nav = open(buildEpub(withConfig({ tocOrnament: "center" })))[
      "OEBPS/nav.xhtml"
    ];

    expect(nav).toContain("ornament-center");
    // XHTMLの中のSVGは名前空間が要る（無いとリーダーが本ごと開けない）
    expect(nav).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  });

  test("目次の飾りと奥付の飾りは別々に選べる", () => {
    const files = open(
      buildEpub(withConfig({ tocOrnament: "center", colophonOrnament: "none" }))
    );

    expect(files["OEBPS/nav.xhtml"]).toContain("ornament-center");
    expect(files["OEBPS/colophon.xhtml"]).not.toContain("ornament");
  });
});

describe("プレビューと書き出しは同じ断片を使う（設計書6.65.6）", () => {
  /**
   * **エディター画面のプレビューは、ここで作った断片をそのまま出す。**
   * 画面用の組版をもう1つ書くと、見た目どおりという要件がその日から壊れる。
   */
  test("目次の断片が、書き出したnav.xhtmlの中にそのまま入っている", () => {
    const config = { ...defaultBookConfig("氷の街"), tocOrnament: "rule" as const };
    const nav = open(buildEpub({ ...book(), config }))["OEBPS/nav.xhtml"];

    expect(nav).toContain(
      buildTocFragment(
        [
          { href: "chapter-001.xhtml", label: "第一話　出会い" },
          { href: "chapter-002.xhtml", label: "第二話　別れ" },
        ],
        {
          pattern: config.tocPattern,
          ornament: config.tocOrnament,
          colophonHref: "colophon.xhtml",
        }
      )
    );
  });

  test("奥付・表紙・扉の断片も、そのまま入っている", () => {
    const config = {
      ...defaultBookConfig("氷の街"),
      author: "野中",
      colophonOrnament: "center" as const,
    };
    const files = open(buildEpub({ ...book(), config }));

    expect(files["OEBPS/colophon.xhtml"]).toContain(
      buildColophonFragment(config)
    );
    expect(files["OEBPS/cover.xhtml"]).toContain(buildCoverFragment(config, null));
    // 表紙画像が無いときの表紙は、題名だけの扉そのもの
    expect(buildCoverFragment(config, null)).toBe(buildTitlePageFragment(config));
  });

  test("CSSも同じものを渡す", () => {
    const css = open(buildEpub(book()))["OEBPS/style.css"];
    expect(css).toBe(buildEpubCss(true));
  });
});

describe("プレビュー用にCSSを閉じ込める", () => {
  /**
   * 画面の中では `html` や `body` に当ててしまうとパネル全体が本の体裁に
   * なる。**同じCSSを1か所から作り**、選択子だけを枠の中へ閉じ込める。
   */
  const scoped = scopeCssForPreview(buildEpubCss(true), ".epub-page");

  test("html と body は枠そのものになる", () => {
    expect(scoped).toContain(".epub-page {");
    expect(scoped).not.toMatch(/(^|\n)html\s*\{/);
    expect(scoped).not.toMatch(/(^|\n)body\s*\{/);
  });

  test("ほかの選択子は枠の中に限る", () => {
    expect(scoped).toContain(".epub-page .nav-list");
    expect(scoped).toContain(".epub-page ruby");
  });

  test("@charset は落とす（画面のCSSには置けない）", () => {
    expect(scoped).not.toContain("@charset");
  });

  test("縦書きの指定は残る（見た目どおりが要件）", () => {
    expect(scoped).toContain("writing-mode: vertical-rl");
  });
});

describe("表紙画像の種類", () => {
  test("拡張子から判定する", () => {
    expect(imageMediaType("表紙.png")).toBe("image/png");
    expect(imageMediaType("表紙.JPG")).toBe("image/jpeg");
    expect(imageMediaType("表紙.jpeg")).toBe("image/jpeg");
    // GIFはEPUB3の中核の形式（3.0から）。断る理由が無い
    expect(imageMediaType("表紙.gif")).toBe("image/gif");
  });

  test("扱えない種類は、分かる言葉で断る", () => {
    expect(() => imageMediaType("表紙.bmp")).toThrow(/bmp/);
    expect(() => imageMediaType("表紙")).toThrow();
  });

  /**
   * **webp は受け取らない。**
   *
   * EPUB 3.3 で中核の形式に入ったばかりで、この本のOPFが名乗るのは
   * `version="3.0"` である。古いリーダーは表示できず、epubcheck 4系は
   * 咎める。**「入れられません」だけでは作者が次に何をすればよいか
   * 分からない**ので、変換先まで言う。
   */
  test("webp は、変換先まで言って断る", () => {
    expect(() => imageMediaType("表紙.webp")).toThrow(/webp/);
    expect(() => imageMediaType("表紙.webp")).toThrow(/PNG/);
    expect(() => imageMediaType("表紙.WEBP")).toThrow(/PNG/);
    // 案内する種類にも webp を並べない（断りながら勧めることになる）
    expect(() => imageMediaType("表紙.bmp")).not.toThrow(/webp/);
  });

  test("挿絵・人物イラストでも同じ種類しか受け取らない", () => {
    // 片方だけ緩いと、そちらが抜け道になる（表紙・裏表紙と同じ約束）
    expect(() => imageMediaType("素材/挿絵.webp", "挿絵")).toThrow(/挿絵/);
    expect(() =>
      imageMediaType("素材/月島.webp", "人物イラスト")
    ).toThrow(/人物イラスト/);
  });
});

/**
 * 登場人物一覧（設計書6.65.11）。
 *
 * **目次の後・本文の前の1面**である。既定では出さないので、`enabled` を
 * 立てたときだけ面が増える。
 */
describe("登場人物一覧の面", () => {
  const characters = [
    {
      name: "月島灯",
      reading: "つきしまあかり",
      summary: "生活保護課の新人",
      icon: null,
    },
    { name: "白石", reading: null, summary: "", icon: null },
  ];

  function order(files: Record<string, string>): string[] {
    return [...files["OEBPS/content.opf"].matchAll(/<itemref idref="([^"]+)"/g)].map(
      (match) => match[1]
    );
  }

  test("目次の後・本文の前に入る", () => {
    const files = open(
      buildEpub({
        ...withConfig({ characterPage: { enabled: true, showIcons: true } }),
        characters,
      })
    );
    const spine = order(files);

    expect(spine.indexOf("nav")).toBeLessThan(spine.indexOf("characters"));
    expect(spine.indexOf("characters")).toBeLessThan(
      spine.indexOf("chapter-001")
    );
    expect(files["OEBPS/characters.xhtml"]).toContain("月島灯");
    expect(files["OEBPS/content.opf"]).toContain('href="characters.xhtml"');
  });

  test("目次を出さない本でも、本文の前に入る", () => {
    const spine = order(
      open(
        buildEpub({
          ...withConfig({
            tocEnabled: false,
            characterPage: { enabled: true, showIcons: true },
          }),
          characters,
        })
      )
    );

    expect(spine.indexOf("characters")).toBeLessThan(
      spine.indexOf("chapter-001")
    );
    expect(spine).not.toContain("nav");
  });

  test("目次からも辿れる（本文の前なので先頭に置く）", () => {
    const nav = open(
      buildEpub({
        ...withConfig({ characterPage: { enabled: true, showIcons: true } }),
        characters,
      })
    )["OEBPS/nav.xhtml"];

    expect(nav).toContain('href="characters.xhtml"');
    expect(nav.indexOf("characters.xhtml")).toBeLessThan(
      nav.indexOf("chapter-001.xhtml")
    );
  });

  test("既定（出さない）なら、面そのものが無い", () => {
    const files = open(buildEpub({ ...book(), characters }));

    expect(files["OEBPS/characters.xhtml"]).toBeUndefined();
    expect(files["OEBPS/content.opf"]).not.toContain("characters");
  });

  test("出す設定でも、載せる人物が居なければ面を作らない", () => {
    const files = open(
      buildEpub(
        withConfig({ characterPage: { enabled: true, showIcons: true } })
      )
    );

    expect(files["OEBPS/characters.xhtml"]).toBeUndefined();
  });

  /** 挿絵と同じ流儀。作者のファイル名は使わず、機械名に付け替える */
  test("人物イラストは portrait-1 の機械名で入る", () => {
    const files = open(
      buildEpub({
        ...withConfig({ characterPage: { enabled: true, showIcons: true } }),
        characters: [
          {
            name: "月島灯",
            reading: null,
            summary: "",
            icon: {
              sourcePath: "素材/月島 灯.png",
              data: new Uint8Array([0x89, 0x50]),
            },
          },
        ],
      })
    );

    expect(files["OEBPS/portrait-1.png"]).toBeDefined();
    expect(files["OEBPS/characters.xhtml"]).toContain('src="portrait-1.png"');
    expect(files["OEBPS/content.opf"]).toContain('id="portrait-1"');
    // 表紙の印は本に1つだけ。人物イラストには付けない
    expect(files["OEBPS/content.opf"]).not.toMatch(
      /<item[^>]*id="portrait-1"[^>]*cover-image/
    );
  });

  /**
   * **同じ絵は1回だけ入れる**（挿絵と同じ流儀。設計書6.65.11）。
   *
   * 集合写真を家族3人ぶんの欄に置くような使い方で、同じバイト列が
   * 人数ぶん詰まると本が重くなる。OPFのmanifestも、同じidが2つ並ぶと
   * epubcheck が咎める。
   */
  test("同じイラストを2人で使っても、入るのは1回だけ", () => {
    const icon = {
      sourcePath: "素材/家族写真.png",
      data: new Uint8Array([0x89, 0x50]),
    };
    const files = open(
      buildEpub({
        ...withConfig({ characterPage: { enabled: true, showIcons: true } }),
        characters: [
          { name: "月島灯", reading: null, summary: "", icon },
          { name: "月島渉", reading: null, summary: "", icon },
        ],
      })
    );
    const opf = files["OEBPS/content.opf"];
    const page = files["OEBPS/characters.xhtml"];

    expect(
      Object.keys(files).filter((name) => name.startsWith("OEBPS/portrait-"))
    ).toEqual(["OEBPS/portrait-1.png"]);
    // 2人とも同じ絵を指す（載る人は減らない）
    expect([...page.matchAll(/src="portrait-1\.png"/g)]).toHaveLength(2);
    // manifest に同じidを2つ並べない
    expect([...opf.matchAll(/id="portrait-1"/g)]).toHaveLength(1);
  });

  /**
   * **イラストが読めない人物も、名前だけで載る**（設計書6.65.11）。
   * ここへ届く前に読めなかったものは `icon: null` になっている。
   */
  test("イラストの無い人物が混ざっても、載る人は減らない", () => {
    const files = open(
      buildEpub({
        ...withConfig({ characterPage: { enabled: true, showIcons: true } }),
        characters: [
          { name: "白石", reading: null, summary: "", icon: null },
          {
            name: "月島灯",
            reading: null,
            summary: "",
            icon: {
              sourcePath: "素材/月島.png",
              data: new Uint8Array([0x89, 0x50]),
            },
          },
        ],
      })
    );
    const page = files["OEBPS/characters.xhtml"];

    expect(page).toContain("白石");
    expect(page).toContain("月島灯");
    // 絵のある人だけが画像を持つ（機械名は絵の側で1から数える）
    expect([...page.matchAll(/<img /g)].length).toBe(1);
    expect(page).toContain('src="portrait-1.png"');
    expect(files["OEBPS/portrait-1.png"]).toBeDefined();
  });
});

/**
 * 書体の組み込み（設計書6.65.11）。
 *
 * **フォールバックは必ず serif を後ろに置く。** 同梱フォントを読まない
 * リーダーでも、本文が消えないようにするためである。
 */
describe("書体の同梱", () => {
  const bodyFont = {
    fileName: "素材/本文.ttf",
    data: new Uint8Array([0x00, 0x01, 0x00, 0x00]),
  };
  const headingFont = {
    fileName: "素材/見出し.otf",
    data: new Uint8Array([0x4f, 0x54, 0x54, 0x4f]),
  };

  test("manifest に載り、@font-face で当たる", () => {
    const files = open(
      buildEpub({ ...book(), fonts: { body: bodyFont, heading: headingFont } })
    );
    const opf = files["OEBPS/content.opf"];
    const css = files["OEBPS/style.css"];

    expect(opf).toContain('href="font-body.ttf"');
    expect(opf).toContain('media-type="font/ttf"');
    expect(opf).toContain('href="font-heading.otf"');
    expect(opf).toContain('media-type="font/otf"');
    expect(files["OEBPS/font-body.ttf"]).toBeDefined();
    expect(files["OEBPS/font-heading.otf"]).toBeDefined();

    expect(css).toContain("@font-face");
    expect(css).toContain('url("font-body.ttf")');
    expect(css).toContain('url("font-heading.otf")');
  });

  test("本文用は body に、見出し用は見出しに当たる", () => {
    const css = open(
      buildEpub({ ...book(), fonts: { body: bodyFont, heading: headingFont } })
    )["OEBPS/style.css"];

    const bodyRule = /body \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(bodyRule).toContain("BookBody");
    // 見出しは h1・h2 に当てる（話の見出し・目次・奥付が全部これ）
    expect(css).toMatch(/h1, h2[^{]*\{[^}]*BookHeading/);
  });

  test("フォールバックの最後は必ず serif", () => {
    const css = open(
      buildEpub({ ...book(), fonts: { body: bodyFont, heading: headingFont } })
    )["OEBPS/style.css"];
    // `@font-face` の中の font-family は「同梱した書体の名前」であって
    // 並びではない。字を当てている側だけを見る
    const stacks = css.replace(/@font-face \{[^}]*\}/g, "");

    const found = [...stacks.matchAll(/font-family:([^;]*);/g)];
    expect(found.length).toBeGreaterThan(1);
    for (const rule of found) {
      expect(rule[1].trim().endsWith("serif"), rule[0]).toBe(true);
    }
  });

  test("片方だけの指定もできる", () => {
    const css = open(
      buildEpub({ ...book(), fonts: { body: bodyFont, heading: null } })
    )["OEBPS/style.css"];

    expect(css).toContain('url("font-body.ttf")');
    expect(css).not.toContain("BookHeading");
  });

  test("指定が無ければ @font-face そのものが無い（第1段と同じ本）", () => {
    const files = open(buildEpub(book()));

    expect(files["OEBPS/style.css"]).not.toContain("@font-face");
    expect(files["OEBPS/content.opf"]).not.toContain("font/ttf");
  });

  test("扱えない種類は、分かる言葉で断る", () => {
    expect(() => fontMediaType("本文.woff2")).toThrow(/woff2/);
    expect(() => fontMediaType("本文")).toThrow();
    expect(fontMediaType("本文.TTF")).toBe("font/ttf");
    expect(fontMediaType("見出し.otf")).toBe("font/otf");
  });

  /** 画面のプレビューにも同じ書体を当てる（設計書6.65.11） */
  test("プレビュー用に閉じ込めても @font-face は外に残る", () => {
    const scoped = scopeCssForPreview(
      buildEpubCss(true, {
        bodyHref: "https://example/font-body.ttf",
        headingHref: null,
      }),
      ".epub-page"
    );

    expect(scoped).toContain("@font-face {");
    // 枠の中へ閉じ込めると、@font-face そのものが効かなくなる
    expect(scoped).not.toContain(".epub-page @font-face");
    expect(scoped).toContain('url("https://example/font-body.ttf")');
    expect(scoped).toContain(".epub-page {");
  });
});

/**
 * 面の並び（設計書6.65.15の段B）。
 *
 * **blocks の順が読む順（spine）になる。** ここで固定するのは2つ——
 * 書いた順のとおりに並ぶことと、**blocks を書いていない本がいままでと
 * 1面も変わらない**こと（回帰の見張り）。
 */
describe("ブロックの並びで面を組む（設計書6.65.15）", () => {
  function spine(files: Record<string, string>): string[] {
    return [
      ...files["OEBPS/content.opf"].matchAll(/<itemref idref="([^"]+)"/g),
    ].map((match) => match[1]);
  }

  test("blocks を書いていない本は、いままでと同じ並びのまま", () => {
    // **第1段からの本を1面も変えない。** 数えるのではなく並びごと固定する
    expect(spine(open(buildEpub(book())))).toEqual([
      "cover",
      "titlepage",
      "nav",
      "chapter-001",
      "chapter-002",
      "colophon",
    ]);
  });

  test("書いた順が、そのまま読む順になる", () => {
    const files = open(
      buildEpub(
        book({
          blocks: [
            { type: "body" },
            { type: "halfTitle" },
            { type: "cover" },
            { type: "colophon" },
          ],
        })
      )
    );

    expect(spine(files)).toEqual([
      "chapter-001",
      "chapter-002",
      "titlepage",
      "cover",
      "colophon",
    ]);
  });

  test("並びに無い面は、ファイルごと作らない", () => {
    const files = open(
      buildEpub(book({ blocks: [{ type: "cover" }, { type: "body" }] }))
    );

    expect(files["OEBPS/colophon.xhtml"]).toBeUndefined();
    expect(files["OEBPS/content.opf"]).not.toContain('href="colophon.xhtml"');
    // **nav.xhtml だけは残す**（EPUB3で必須。第1段からの約束）
    expect(files["OEBPS/nav.xhtml"]).toBeDefined();
    expect(spine(files)).toEqual(["cover", "chapter-001", "chapter-002"]);
  });
});

describe("口絵・扉絵の面（設計書6.65.15）", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  function plated(): Record<string, string> {
    return open(
      buildEpub(
        book({
          blocks: [
            { type: "cover" },
            {
              type: "frontIllustration",
              sourcePath: "素材/口絵.png",
              data: png,
              caption: "旅立ちの朝",
            },
            { type: "body" },
          ],
        })
      )
    );
  }

  test("画像は機械名でZIPへ入り、面と一緒に manifest へ載る", () => {
    const files = plated();
    const opf = files["OEBPS/content.opf"];

    // 作者のファイル名は使わない（表紙・挿絵と同じ理由）
    expect(files["OEBPS/plate-1.png"]).toBeDefined();
    expect(files["OEBPS/素材/口絵.png"]).toBeUndefined();
    expect(opf).toContain('href="plate-1.png"');
    expect(opf).toContain('media-type="image/png"');
    expect(opf).toContain('href="plate-page-1.xhtml"');
    // 表紙は本に1つだけ。口絵に cover-image の印は付かない
    expect(opf).not.toMatch(
      /<item[^>]*href="plate-1\.png"[^>]*properties="cover-image"/
    );
  });

  test("解説文は図版の下に添える（画像には重ねない）", () => {
    const face = plated()["OEBPS/plate-page-1.xhtml"];

    expect(face).toContain('src="plate-1.png"');
    expect(face).toContain("<figcaption>旅立ちの朝</figcaption>");
    expect(face.indexOf("<img")).toBeLessThan(face.indexOf("<figcaption>"));
  });

  test("解説文が無ければ figcaption そのものを出さない", () => {
    const files = open(
      buildEpub(
        book({
          blocks: [
            { type: "body" },
            {
              type: "sectionArt",
              sourcePath: "素材/扉.png",
              data: png,
              caption: "",
            },
          ],
        })
      )
    );

    expect(files["OEBPS/plate-page-1.xhtml"]).not.toContain("<figcaption>");
  });

  test("同じ絵を2か所で使っても、画像が入るのは1回だけ（面は2つ）", () => {
    const files = open(
      buildEpub(
        book({
          blocks: [
            {
              type: "frontIllustration",
              sourcePath: "素材/絵.png",
              data: png,
              caption: "",
            },
            { type: "body" },
            {
              type: "sectionArt",
              sourcePath: "素材/絵.png",
              data: png,
              caption: "",
            },
          ],
        })
      )
    );
    const opf = files["OEBPS/content.opf"];

    expect(files["OEBPS/plate-1.png"]).toBeDefined();
    expect(files["OEBPS/plate-2.png"]).toBeUndefined();
    // 面は2つ。**同じ絵を2度詰めない**（挿絵・人物イラストと同じ流儀）
    expect(files["OEBPS/plate-page-1.xhtml"]).toBeDefined();
    expect(files["OEBPS/plate-page-2.xhtml"]).toBeDefined();
    expect(opf.match(/href="plate-1\.png"/g)).toHaveLength(1);
  });

  test("扱えない種類は、分かる言葉で断る", () => {
    expect(() =>
      buildEpub(
        book({
          blocks: [
            { type: "body" },
            {
              type: "frontIllustration",
              sourcePath: "素材/口絵.webp",
              data: png,
              caption: "",
            },
          ],
        })
      )
    ).toThrow(/口絵/);
  });
});

describe("あとがきの面（設計書6.65.15）", () => {
  function withAfterword(text: string): Record<string, string> {
    return open(
      buildEpub(
        book({
          blocks: [
            { type: "body" },
            { type: "afterword", text, notation: "curly" },
            { type: "colophon" },
          ],
        })
      )
    );
  }

  test("本文と同じ組版で1面になり、見出しは「あとがき」", () => {
    const files = withAfterword("{拙作|せっさく}をお読みいただき\n\nありがとう");
    const face = files["OEBPS/afterword.xhtml"];

    expect(face).toContain("あとがき");
    // 本文と同じ組版（ルビが組まれ、段落は <p> になる）
    expect(face).toContain("<ruby>拙作<rt>せっさく</rt></ruby>");
    expect(face).toContain("<p>ありがとう</p>");
    expect(files["OEBPS/content.opf"]).toContain('href="afterword.xhtml"');
  });

  test("読む順は本文の後・奥付の前", () => {
    const spine = [
      ...withAfterword("ありがとう")["OEBPS/content.opf"].matchAll(
        /<itemref idref="([^"]+)"/g
      ),
    ].map((match) => match[1]);

    expect(spine).toEqual([
      "chapter-001",
      "chapter-002",
      "afterword",
      "colophon",
    ]);
  });

  test("目次にも行が入る（本文の後・奥付の前）", () => {
    const nav = withAfterword("ありがとう")["OEBPS/nav.xhtml"];

    expect(nav).toContain('<a href="afterword.xhtml">あとがき</a>');
    expect(nav.indexOf("afterword.xhtml")).toBeLessThan(
      nav.indexOf("colophon.xhtml")
    );
  });

  test("中身が無ければ、面ごと出さない", () => {
    for (const text of ["", "   \n\n", "// まだ書いていない"]) {
      const files = withAfterword(text);

      expect(files["OEBPS/afterword.xhtml"], text).toBeUndefined();
      expect(files["OEBPS/content.opf"]).not.toContain("afterword.xhtml");
      expect(files["OEBPS/nav.xhtml"]).not.toContain("あとがき");
    }
  });
});
