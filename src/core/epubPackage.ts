import { zipSync, type Zippable } from "fflate";
import type { BookConfig, BookOrnament, TocPattern } from "../models/book";
import {
  buildChapterXhtml,
  buildXhtmlDocument,
  escapeXml,
  type EpubChapterSource,
} from "./epubXhtml";

/**
 * EPUB3の中身を組み立てて、1つのZIP（＝.epubファイル）にする
 * （設計書6.65.4の第1段）。
 *
 * ## ZIPは fflate で作る
 *
 * **Node専用のZIPライブラリは使えない**（設計書5.8。ブラウザ版でも
 * 動く必要がある）。fflate は純JSで、`node:` に触らないので静的 import
 * してよい。
 *
 * ## `mimetype` の置き方だけは、仕様どおりでないと本にならない
 *
 * EPUBは「**先頭エントリが `mimetype`・無圧縮・拡張フィールドなし**」と
 * 決まっている。リーダーはZIPの先頭30バイトほどを覗いてEPUBかどうかを
 * 判断するので、ここを外すと**中身がどれだけ正しくても本として開かない**。
 * `zipSync` はオブジェクトのキーの順に詰めるので、`mimetype` を最初に
 * 置き、そこだけ `level: 0`（無圧縮）にしている。
 *
 * ## 中身は OEBPS/ に平らに置く
 *
 * 階層を作ると、CSSや目次のリンクが面ごとに `../` の有無で変わる。
 * 第1段では**全部を `OEBPS/` 直下**へ置き、リンクはどこから見ても
 * ファイル名だけで済むようにした。
 *
 * ## 面の断片は外から呼べるようにしてある（第2段）
 *
 * エディター画面（`features/epubEditorPanel.ts`）のプレビューは、
 * **ここで作った断片とCSSをそのまま出す**。画面用の組版をもう1つ書くと、
 * 「見た目どおりに編集できる」という要件がその日から壊れる
 * （設計書6.65.6）。
 *
 * ここは vscode に触らない（単体テストできる）。
 */

export const EPUB_MIMETYPE = "application/epub+zip";

/** OPFから見た相対パスの基点。ZIPの中では `OEBPS/` の下 */
const ROOT = "OEBPS";
const CSS_NAME = "style.css";
const NAV_NAME = "nav.xhtml";
const COVER_NAME = "cover.xhtml";
const TITLEPAGE_NAME = "titlepage.xhtml";
const COLOPHON_NAME = "colophon.xhtml";

/** 本の中の1話。組み方は `epubXhtml.ts` が持つので、そのまま通す */
export interface EpubChapter extends EpubChapterSource {
  /**
   * 目次を章ごとに区切るときの束ね名（設計書6.65.6）。
   *
   * **無ければ束ねない。** 話数しか分からない作品で章を捏造すると、
   * 作者が書いていない構成が本に載る。作り方は
   * `core/episodeLabel.ts` の `episodeGroupLabel`。
   */
  group?: string;
}

export interface EpubCover {
  /** 元のファイル名。種類の判定にだけ使う（ZIPの中では `cover.<拡張子>`） */
  fileName: string;
  data: Uint8Array;
}

export interface EpubBook {
  config: BookConfig;
  chapters: readonly EpubChapter[];
  /** 表紙画像。無ければ題名と作者名の扉になる */
  cover: EpubCover | null;
  /**
   * `dc:identifier`。本を見分ける唯一の札。
   *
   * **呼び出し側が渡す。** ここで作ると同じ内容から毎回違う本ができて、
   * 単体テストが書けない（`features/exportEpub.ts` が `randomUuid()` で作る）。
   */
  identifier: string;
  /** `dcterms:modified`。`2026-09-03T00:00:00Z` の形（EPUB3で必須） */
  modified: string;
}

/**
 * 拡張子から画像の種類を決める。
 *
 * **中身は見ない。** 種類を当てにいくより、扱えないものを分かる言葉で
 * 断るほうが作者の手間が少ない（拡張子を直せば済む）。
 */
export function imageMediaType(fileName: string): string {
  const matched = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  if (!matched) {
    throw new Error(
      `表紙「${fileName}」に拡張子がありません。png・jpg・jpeg・webp のいずれかにしてください。`
    );
  }
  const extension = matched[1].toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[extension];
  if (!mediaType) {
    throw new Error(
      `表紙の種類「${extension}」は本に入れられません。png・jpg・jpeg・webp のいずれかにしてください。`
    );
  }
  return mediaType;
}

/** EPUB3が「どのリーダーでも表示できる」と定めている画像の種類 */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function buildEpub(book: EpubBook): Uint8Array {
  if (book.chapters.length === 0) {
    throw new Error("本文が1話もないので、本を組めませんでした。");
  }

  const config = book.config;
  const vertical = config.writingMode === "vertical";
  const cover = book.cover
    ? {
        ...book.cover,
        mediaType: imageMediaType(book.cover.fileName),
        // ZIPの中の名前はこちらで決める。作者のファイル名をそのまま使うと、
        // 空白や日本語の扱いがリーダーごとに違って、表紙だけ出ないことがある
        packagedName: `cover${extensionOf(book.cover.fileName)}`,
      }
    : null;

  const chapters = book.chapters.map((chapter, index) => ({
    ...chapter,
    id: `chapter-${String(index + 1).padStart(3, "0")}`,
    fileName: `chapter-${String(index + 1).padStart(3, "0")}.xhtml`,
  }));

  const files: Zippable = {
    // **先頭・無圧縮。** ここを外すとリーダーが本と認識しない
    mimetype: [encode(EPUB_MIMETYPE), { level: 0 }],
    "META-INF/container.xml": encode(containerXml()),
    [`${ROOT}/content.opf`]: encode(
      contentOpf(book, chapters, cover, vertical)
    ),
    [`${ROOT}/${CSS_NAME}`]: encode(buildEpubCss(vertical)),
    [`${ROOT}/${NAV_NAME}`]: encode(navXhtml(chapters, config, vertical)),
    [`${ROOT}/${COVER_NAME}`]: encode(coverXhtml(config, cover, vertical)),
    [`${ROOT}/${TITLEPAGE_NAME}`]: encode(titlePageXhtml(config, vertical)),
    [`${ROOT}/${COLOPHON_NAME}`]: encode(colophonXhtml(config, vertical)),
  };

  if (cover) files[`${ROOT}/${cover.packagedName}`] = cover.data;

  for (const chapter of chapters) {
    files[`${ROOT}/${chapter.fileName}`] = encode(
      buildChapterXhtml(chapter, {
        collapseBlankLines: config.collapseBlankLines,
        cssHref: CSS_NAME,
        vertical,
      })
    );
  }

  return zipSync(files);
}

interface PackagedChapter extends EpubChapter {
  id: string;
  fileName: string;
}

interface PackagedCover extends EpubCover {
  mediaType: string;
  packagedName: string;
}

function containerXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    "  <rootfiles>",
    `    <rootfile full-path="${ROOT}/content.opf" media-type="application/oebps-package+xml" />`,
    "  </rootfiles>",
    "</container>",
    "",
  ].join("\n");
}

/**
 * 本の目録（OPF）。
 *
 * **`manifest` に無いファイルは、本の中に無いのと同じ。** 話を足すたびに
 * ここへ載せ忘れると、リンクを踏んでも何も出ないという分かりにくい
 * 壊れ方をするので、`manifest` と `spine` は同じ配列から組む。
 *
 * **空の項目は要素ごと出さない。** 空の `<dc:creator></dc:creator>` は
 * 「作者名が空文字である」という主張になり、リーダーによっては
 * 著者欄が空白のまま本棚へ並ぶ。
 */
function contentOpf(
  book: EpubBook,
  chapters: readonly PackagedChapter[],
  cover: PackagedCover | null,
  vertical: boolean
): string {
  const config = book.config;

  const metadata = [
    `    <dc:identifier id="bookid">${escapeXml(
      book.identifier
    )}</dc:identifier>`,
    `    <dc:title>${escapeXml(config.title || "無題")}</dc:title>`,
    ...(config.author
      ? [`    <dc:creator>${escapeXml(config.author)}</dc:creator>`]
      : []),
    // イラストレーターは著者ではないので `dc:contributor`。役割を
    // `marc:relators` の ill（illustrator）で添える
    ...(config.illustrator
      ? [
          `    <dc:contributor id="illustrator">${escapeXml(
            config.illustrator
          )}</dc:contributor>`,
          '    <meta refines="#illustrator" property="role" scheme="marc:relators">ill</meta>',
        ]
      : []),
    ...(config.label
      ? [`    <dc:publisher>${escapeXml(config.label)}</dc:publisher>`]
      : []),
    "    <dc:language>ja</dc:language>",
    `    <meta property="dcterms:modified">${escapeXml(
      book.modified
    )}</meta>`,
    // EPUB2しか読めないリーダー（Kindleの古い変換など）は
    // `properties="cover-image"` を見ない。こちらの目印も残す
    ...(cover
      ? ['    <meta name="cover" content="cover-image" />']
      : []),
  ];

  const manifest = [
    `    <item id="nav" href="${NAV_NAME}" media-type="application/xhtml+xml" properties="nav" />`,
    `    <item id="style" href="${CSS_NAME}" media-type="text/css" />`,
    `    <item id="cover" href="${COVER_NAME}" media-type="application/xhtml+xml" />`,
    `    <item id="titlepage" href="${TITLEPAGE_NAME}" media-type="application/xhtml+xml" />`,
    ...(cover
      ? [
          `    <item id="cover-image" href="${cover.packagedName}" media-type="${cover.mediaType}" properties="cover-image" />`,
        ]
      : []),
    ...chapters.map(
      (chapter) =>
        `    <item id="${chapter.id}" href="${chapter.fileName}" media-type="application/xhtml+xml" />`
    ),
    `    <item id="colophon" href="${COLOPHON_NAME}" media-type="application/xhtml+xml" />`,
  ];

  const spine = [
    '    <itemref idref="cover" />',
    // 扉は表紙の直後・目次の前（設計書6.65.3の表の並び）。
    // **出したり消したりしない**——表紙が画像1枚の本では、題名や
    // 作者名を読む場所がここしかない
    '    <itemref idref="titlepage" />',
    // **目次を外しても `nav.xhtml` は残す**（EPUB3で必須）。
    // ここで外すのは「読む順路に並べるか」だけである
    ...(config.tocEnabled ? ['    <itemref idref="nav" />'] : []),
    ...chapters.map((chapter) => `    <itemref idref="${chapter.id}" />`),
    '    <itemref idref="colophon" />',
  ];

  // 縦書きは右から左へ開く。横書きは既定（左→右）なので**書かない**
  const direction = vertical ? ' page-progression-direction="rtl"' : "";

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    ...metadata,
    "  </metadata>",
    "  <manifest>",
    ...manifest,
    "  </manifest>",
    `  <spine${direction}>`,
    ...spine,
    "  </spine>",
    "</package>",
    "",
  ].join("\n");
}

/**
 * 目次。
 *
 * `nav.xhtml` は EPUB3 の必須ファイルで、リーダーの「目次」ボタンが
 * 見るのもこれである。`tocEnabled` が false でも作り、読む順路
 * （`spine`）へ並べないことで「読み物としての目次ページ」だけを省く。
 */
function navXhtml(
  chapters: readonly PackagedChapter[],
  config: BookConfig,
  vertical: boolean
): string {
  return buildXhtmlDocument({
    title: "目次",
    cssHref: CSS_NAME,
    vertical,
    body: buildTocFragment(
      chapters.map((chapter) => ({
        href: chapter.fileName,
        label: chapter.heading.trim() || chapter.fileName,
        group: chapter.group,
      })),
      {
        pattern: config.tocPattern,
        ornament: config.tocOrnament,
        colophonHref: COLOPHON_NAME,
      }
    ),
  });
}

/** 目次に並べる1行 */
export interface EpubTocEntry {
  /** 行き先。プレビューでは押しても飛ばないが、同じものを渡す */
  href: string;
  label: string;
  /** 章ごとに区切るときの束ね名。無ければ束ねない */
  group?: string;
}

export interface EpubTocOptions {
  pattern: TocPattern;
  ornament: BookOrnament;
  /** 末尾に置く奥付への行。null なら出さない */
  colophonHref?: string | null;
}

/**
 * 目次の断片（`<nav>` ごと）。**書き出しとプレビューが共に使う。**
 *
 * ## `<nav>` の中には見出しと `<ol>` しか置けない
 *
 * EPUB3は目次の `nav` の中身を「見出し（あれば）＋ `ol`」と定めており、
 * 飾りの罫線をそのあいだへ挟むと epubcheck が咎める。**飾りは見出しの
 * 中へ入れる**——`<span>` も `<svg>` も見出しの中に置ける文字物なので、
 * 仕様を外れずに「見出しの下の飾り」を作れる。
 *
 * ## 章で束ねるのは、束ね名があるときだけ
 *
 * 束ね名が1つも無ければ一覧のまま出す。話数しか分からない作品に
 * 「本編」だけの見出しを立てても、作者に伝わるものが増えない。
 */
export function buildTocFragment(
  entries: readonly EpubTocEntry[],
  options: EpubTocOptions
): string {
  const grouped =
    options.pattern === "chapters" &&
    entries.some((entry) => (entry.group ?? "").trim() !== "");

  const listClass = grouped
    ? "nav-list toc-chapters"
    : options.pattern === "horizontal"
      ? "nav-list toc-horizontal"
      : "nav-list toc-vertical";

  const colophon =
    options.colophonHref === null || options.colophonHref === undefined
      ? []
      : [`    <li><a href="${escapeXml(options.colophonHref)}">奥付</a></li>`];

  return [
    '<nav epub:type="toc" id="toc">',
    `<h1 class="nav-heading">目次${buildOrnamentFragment(
      options.ornament
    )}</h1>`,
    `  <ol class="${listClass}">`,
    ...(grouped ? groupedItems(entries) : flatItems(entries)),
    ...colophon,
    "  </ol>",
    "</nav>",
  ].join("\n");
}

function flatItems(entries: readonly EpubTocEntry[]): string[] {
  return entries.map(
    (entry) =>
      `    <li><a href="${escapeXml(entry.href)}">${escapeXml(
        entry.label
      )}</a></li>`
  );
}

/**
 * 章ごとに区切った並び。
 *
 * **束ね名は `<span>` で出す。** 目次の `li` の中に置けるのは
 * 「`a` か `span`、続けて `ol`」だけで、`h2` を入れると本の検証で落ちる。
 * 束ね名が続くあいだは同じ章にまとめ、変わったところで章を切る
 * （並べ替えはしない——本の順序が変わってしまう）。
 */
function groupedItems(entries: readonly EpubTocEntry[]): string[] {
  const out: string[] = [];
  let current: string | null = null;

  for (const entry of entries) {
    const group = (entry.group ?? "").trim();
    if (group !== current) {
      if (current !== null) out.push("      </ol>", "    </li>");
      current = group;
      out.push(
        `    <li><span class="toc-group">${escapeXml(group)}</span>`,
        "      <ol>"
      );
    }
    out.push(
      `        <li><a href="${escapeXml(entry.href)}">${escapeXml(
        entry.label
      )}</a></li>`
    );
  }
  if (current !== null) out.push("      </ol>", "    </li>");
  return out;
}

/**
 * 目次・奥付の飾り（設計書6.65.6）。
 *
 * **外部ファイルにしない。** 画像を1つ足すたびにOPFのmanifestへ載せる
 * 必要があり、載せ忘れると「本は開くが飾りだけ出ない」という気づきにくい
 * 壊れ方をする。罫線はCSS、中央飾りはここに書いたSVGで持つ。
 *
 * 縦組みでも横組みでも同じ向きで見えるよう、**中央飾りは左右対称の形**に
 * してある（横長の飾りは、縦組みの本で寝てしまう）。
 */
export function buildOrnamentFragment(kind: BookOrnament): string {
  if (kind === "rule") return '<span class="ornament ornament-rule"></span>';
  if (kind === "center") {
    return (
      '<span class="ornament ornament-center">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"' +
      ' width="24" height="24" aria-hidden="true" role="presentation">' +
      '<path d="M12 2 L16 12 L12 22 L8 12 Z" fill="currentColor" />' +
      "</svg></span>"
    );
  }
  return "";
}

/**
 * 表紙。
 *
 * 画像があれば1枚を敷き、無ければ題名・作者名の扉を組む。
 * **第1段では合成しない**（文字を焼き込むのは第3段。設計書6.65.4）。
 */
function coverXhtml(
  config: BookConfig,
  cover: PackagedCover | null,
  vertical: boolean
): string {
  return buildXhtmlDocument({
    title: config.title || "無題",
    cssHref: CSS_NAME,
    vertical,
    body: buildCoverFragment(
      config,
      cover ? { href: cover.packagedName } : null
    ),
  });
}

/**
 * 表紙の断片。画像があれば1枚を敷き、無ければ**題名だけの扉**になる。
 *
 * 画像が無いときの表紙は `buildTitlePageFragment` そのものである
 * （第1段からこの形。扉の面を別に足すのは第3段）。
 */
export function buildCoverFragment(
  config: BookConfig,
  image: { href: string } | null
): string {
  if (!image) return buildTitlePageFragment(config);
  return [
    '<div class="cover-image">',
    `<img src="${escapeXml(image.href)}" alt="${escapeXml(
      config.title || "表紙"
    )}" />`,
    "</div>",
  ].join("\n");
}

/**
 * タイトルページ（扉）。表紙とは別の1面である（設計書6.65.3）。
 *
 * 表紙が画像1枚のとき、**題名や作者名を文字で読める場所はここだけ**に
 * なる。書いていない項目が多くても面ごと省いたりはしない——面が出たり
 * 消えたりするほうが、作者にも読者にも分かりにくい。
 */
function titlePageXhtml(config: BookConfig, vertical: boolean): string {
  return buildXhtmlDocument({
    title: config.title || "無題",
    cssHref: CSS_NAME,
    vertical,
    body: buildTitlePageFragment(config),
  });
}

/** 題名・作者名・イラストレーター名・レーベル名を組んだ扉 */
export function buildTitlePageFragment(config: BookConfig): string {
  return [
    '<div class="title-page">',
    `<h1 class="book-title">${escapeXml(config.title || "無題")}</h1>`,
    ...(config.author
      ? [`<p class="book-author">${escapeXml(config.author)}</p>`]
      : []),
    ...(config.illustrator
      ? [
          `<p class="book-illustrator">イラスト　${escapeXml(
            config.illustrator
          )}</p>`,
        ]
      : []),
    ...(config.label
      ? [`<p class="book-label">${escapeXml(config.label)}</p>`]
      : []),
    "</div>",
  ].join("\n");
}

/** 奥付 */
function colophonXhtml(config: BookConfig, vertical: boolean): string {
  return buildXhtmlDocument({
    title: "奥付",
    cssHref: CSS_NAME,
    vertical,
    body: buildColophonFragment(config),
  });
}

/**
 * 奥付の断片。書誌情報と飾りだけを組む。
 *
 * **空の項目は行ごと出さない。** 「著者　（空欄）」の並んだ奥付は、
 * 作者が書き忘れたのか、そういう本なのかが読み手に分からない。
 */
export function buildColophonFragment(config: BookConfig): string {
  const rows = [
    ["題名", config.title || "無題"],
    ["著者", config.author],
    ["イラスト", config.illustrator],
    ["発行", config.label],
  ].filter(([, value]) => value);

  return [
    '<div class="colophon">',
    `<h1 class="colophon-heading">奥付${buildOrnamentFragment(
      config.colophonOrnament
    )}</h1>`,
    '  <dl class="colophon-list">',
    ...rows.flatMap(([label, value]) => [
      `    <dt>${escapeXml(label)}</dt>`,
      `    <dd>${escapeXml(value)}</dd>`,
    ]),
    "  </dl>",
    "</div>",
  ].join("\n");
}

/**
 * 体裁。
 *
 * **`-epub-` 付きの書き方も並べる。** 縦書きと圏点を古い書き方でしか
 * 見ないリーダー（iBooks系の一部）が現役で、片方だけだと縦書きの本が
 * 横に流れる。
 */
export function buildEpubCss(vertical: boolean): string {
  const direction = vertical
    ? [
        "html {",
        "  -epub-writing-mode: vertical-rl;",
        "  writing-mode: vertical-rl;",
        // 縦の中で英数字を横に寝かせない
        "  -epub-text-orientation: mixed;",
        "  text-orientation: mixed;",
        "}",
      ]
    : ["html {", "  writing-mode: horizontal-tb;", "}"];

  return [
    "@charset \"UTF-8\";",
    ...direction,
    "body {",
    // 明朝を先に。ゴシックで組んだ小説は読み疲れる（PDF出力と同じ並び）。
    // **書体は同梱しない**（第3段。ライセンスの確認が要る）
    '  font-family: "Yu Mincho", "游明朝", "Hiragino Mincho ProN", serif;',
    "  line-height: 1.8;",
    "  margin: 0;",
    "  padding: 0;",
    "}",
    "h1, h2, p { margin: 0; padding: 0; font-weight: normal; }",
    ".chapter-heading { font-size: 1.3em; letter-spacing: 0.1em; margin-block-end: 2.5em; }",
    // 段落のあいだは空けない。字下げ（全角空白）で見分けるのが日本語の組み方
    "p { margin: 0; text-indent: 0; }",
    // 空きの段落は `<p class="blank"><br /></p>`（`epubXhtml.ts`）。
    // 中身が無いと高さ0に潰れるリーダーがあるので `<br />` を入れてある
    "ruby { ruby-align: center; }",
    "rt { font-size: 0.5em; letter-spacing: 0; }",
    // 傍点は圏点（ゴマ点）。位置は既定のまま（縦なら右、横なら上へ寄る）
    ".emphasis {",
    "  -epub-text-emphasis: filled sesame;",
    "  -webkit-text-emphasis: filled sesame;",
    "  text-emphasis: filled sesame;",
    "}",
    // 表紙は1枚を面いっぱいに。はみ出させない
    ".cover-image { text-align: center; margin: 0; padding: 0; }",
    ".cover-image img { max-width: 100%; max-height: 100%; }",
    ".title-page { text-align: center; margin-block-start: 20%; }",
    ".book-title { font-size: 2em; letter-spacing: 0.25em; }",
    ".book-author { margin-block-start: 3em; font-size: 1.2em; }",
    ".book-illustrator, .book-label { margin-block-start: 1em; }",
    ".nav-heading, .colophon-heading { font-size: 1.5em; margin-block-end: 2em; }",
    ".nav-list { line-height: 2.4; }",
    // 目次だけ横組みにする配置（設計書6.65.6）。**縦組みへの上書きは
    // 持たない**——本文が横組みの本のCSSに縦組みの指定が現れると、
    // 何も選んでいない作者の本の見た目が版で変わる
    ".toc-horizontal {",
    "  -epub-writing-mode: horizontal-tb;",
    "  writing-mode: horizontal-tb;",
    "}",
    // 章で束ねた並び。章の見出しは行頭に立て、話は一段下げる
    ".toc-chapters { list-style: none; padding-inline-start: 0; }",
    ".toc-chapters ol { list-style: none; padding-inline-start: 1.5em; }",
    ".toc-group { display: block; margin-block-start: 1.5em; font-size: 1.1em; }",
    // 飾りは見出しの中に置く（`buildOrnamentFragment` の説明を参照）
    ".ornament { display: block; margin-block-start: 0.6em; text-align: center; }",
    ".ornament-rule {",
    "  border-block-start: 1px solid currentColor;",
    "  inline-size: 60%;",
    "  margin-inline: auto;",
    "}",
    ".ornament-center svg { fill: currentColor; }",
    ".colophon-list dt { margin-block-start: 1em; font-size: 0.9em; }",
    "",
  ].join("\n");
}

/**
 * プレビュー用に、本のCSSを枠の中へ閉じ込める（設計書6.65.6）。
 *
 * **画面用のCSSを別に書かない。** 書き出しと同じ `buildEpubCss` から
 * 作り、`html`・`body` を枠そのものへ、ほかの選択子を枠の中へ置き換える
 * だけにする。2つ持つと、直したほうだけが本物になる。
 *
 * ここで扱うのは**自分で書いたCSS**だけである（入れ子の `@media` などは
 * 出てこない）。汎用のCSSパーサではないので、外から来たCSSは通さないこと。
 */
export function scopeCssForPreview(css: string, scope: string): string {
  const rules: string[] = [];

  for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    // `@charset "UTF-8";` のような文は選択子ではない。最後の `;` までを捨てる
    const head = rule[1].slice(rule[1].lastIndexOf(";") + 1);
    const selectors = head
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean)
      .map((selector) =>
        selector === "html" || selector === "body"
          ? scope
          : `${scope} ${selector}`
      );
    if (selectors.length === 0) continue;
    rules.push(`${selectors.join(", ")} {${rule[2]}}`);
  }

  return rules.join("\n");
}

function extensionOf(fileName: string): string {
  const matched = /\.[A-Za-z0-9]+$/.exec(fileName.trim());
  return matched ? matched[0].toLowerCase() : "";
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
