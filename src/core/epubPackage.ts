import { zipSync, type Zippable } from "fflate";
import {
  BOOK_FONT_EXTENSIONS,
  type BookConfig,
  type BookOrnament,
  type TocPattern,
} from "../models/book";
import {
  buildChapterXhtml,
  buildXhtmlDocument,
  escapeXml,
  type EpubChapterSource,
} from "./epubXhtml";
import {
  buildCharacterPageFragment,
  type EpubCharacterEntry,
} from "./epubCharacterPage";

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
const BACKCOVER_NAME = "backcover.xhtml";
const CHARACTERS_NAME = "characters.xhtml";

/**
 * 同梱した書体を指す名前（設計書6.65.11）。
 *
 * **CSSの中でだけ使う名前**なので、作者のフォント名（「源ノ明朝」など）は
 * 使わない。同じ名前のフォントが端末に入っていると、どちらが当たるか
 * リーダーまかせになる。
 */
const BODY_FONT_FAMILY = "BookBody";
const HEADING_FONT_FAMILY = "BookHeading";

/**
 * 同梱しないときの体裁。**最後は必ず `serif`**（設計書6.65.11）。
 *
 * 明朝を先に並べる。ゴシックで組んだ小説は読み疲れる（PDF出力と同じ並び）。
 */
const BASE_FONT_STACK =
  '"Yu Mincho", "游明朝", "Hiragino Mincho ProN", serif';

/**
 * 本文へ挟む挿絵1枚（設計書6.65.10）。
 *
 * **ZIPの中の名前はここで決めない。** 画像の中身と、それがどの画像かを
 * 見分ける手がかり（作品フォルダからの相対パス）だけを持つ。
 */
export interface EpubIllustration {
  /** 第M段落のあと（詰める前の段落番号） */
  afterParagraph: number;
  /**
   * 作品フォルダからの相対パス。
   *
   * **同じ画像かどうかの見分けに使う。** 1枚の絵を2か所で使う本で、
   * 同じバイト列を2回ZIPへ入れない。種類（media-type）の判定にも使う。
   */
  sourcePath: string;
  data: Uint8Array;
  /** 解説文。空なら `<figcaption>` を出さない */
  caption: string;
}

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
  /** この話へ挟む挿絵（設計書6.65.10） */
  illustrations?: readonly EpubIllustration[];
  /** この話の中で改ページする位置（第M段落のあと） */
  pageBreaks?: readonly number[];
}

export interface EpubCover {
  /** 元のファイル名。種類の判定にだけ使う（ZIPの中では `cover.<拡張子>`） */
  fileName: string;
  data: Uint8Array;
}

/**
 * 登場人物一覧へ載せる1人（設計書6.65.11）。
 *
 * 名前・読み仮名・紹介文の3つだけを持つ（絞り方は
 * `epubCharacterPage.ts`）。イラストは**中身と見分けの手がかり**を渡し、
 * ZIPの中の名前はここで機械名に付け替える（挿絵と同じ）。
 */
export interface EpubBookCharacter {
  name: string;
  reading: string | null;
  summary: string;
  icon: { sourcePath: string; data: Uint8Array } | null;
}

/** 同梱する書体1つ（設計書6.65.11） */
export interface EpubFont {
  /** 元のファイル名。種類の判定に使う（ZIPの中では `font-body.<拡張子>`） */
  fileName: string;
  data: Uint8Array;
}

export interface EpubFonts {
  body: EpubFont | null;
  heading: EpubFont | null;
}

export interface EpubBook {
  config: BookConfig;
  chapters: readonly EpubChapter[];
  /** 表紙画像。無ければ題名と作者名の扉になる */
  cover: EpubCover | null;
  /**
   * 裏表紙の画像（設計書6.65.8）。**本の最終面**になる。
   *
   * **無ければ面ごと出さない。** 空の裏表紙が1面挟まるより、無いほうが
   * よい（表紙のように「文字だけの代わり」は作らない——裏表紙は絵が
   * 無ければ用が無い）。
   */
  backCover: EpubCover | null;
  /**
   * 登場人物一覧に載せる人（設計書6.65.11）。
   *
   * **絞り込みは呼び出し側で済ませてある。** ここは受け取ったものを順に
   * 並べるだけで、台帳の事情（登場済みか・ネタバレ区分）は知らない。
   * `config.characterPage.enabled` が false なら、渡されていても面は出ない。
   */
  characters?: readonly EpubBookCharacter[];
  /** 同梱する書体（設計書6.65.11）。無ければ第1段と同じ本になる */
  fonts?: EpubFonts;
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
export function imageMediaType(fileName: string, label = "表紙"): string {
  const matched = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  if (!matched) {
    throw new Error(
      `${label}「${fileName}」に拡張子がありません。png・jpg・jpeg・webp のいずれかにしてください。`
    );
  }
  const extension = matched[1].toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[extension];
  if (!mediaType) {
    throw new Error(
      `${label}の種類「${extension}」は本に入れられません。png・jpg・jpeg・webp のいずれかにしてください。`
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

/**
 * 書体の種類（設計書6.65.11）。
 *
 * 画像と同じく**中身は見ない**。扱える種類は `models/book.ts` が持つので、
 * ここは media-type への対応だけを持つ（2か所で種類を数え上げない）。
 */
export function fontMediaType(fileName: string, label = "書体"): string {
  const matched = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  const extension = matched ? matched[1].toLowerCase() : "";
  if (!extension) {
    throw new Error(
      `${label}「${fileName}」に拡張子がありません。ttf・otf のいずれかにしてください。`
    );
  }
  if (!BOOK_FONT_EXTENSIONS.includes(extension)) {
    throw new Error(
      `${label}の種類「${extension}」は本に入れられません。ttf・otf のいずれかにしてください。`
    );
  }
  return `font/${extension}`;
}

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
  const backCover = book.backCover
    ? {
        ...book.backCover,
        mediaType: imageMediaType(book.backCover.fileName, "裏表紙"),
        packagedName: `backcover${extensionOf(book.backCover.fileName)}`,
      }
    : null;

  const chapters = book.chapters.map((chapter, index) => ({
    ...chapter,
    id: `chapter-${String(index + 1).padStart(3, "0")}`,
    fileName: `chapter-${String(index + 1).padStart(3, "0")}.xhtml`,
  }));
  const illustrations = packIllustrations(chapters);
  // **面を出すのは「出す設定」かつ「載せる人が居る」ときだけ**
  // （設計書6.65.11）。空の一覧が1面挟まるより、無いほうがよい
  const characters = config.characterPage.enabled
    ? packCharacters(book.characters ?? [])
    : [];
  const fonts = packFonts(book.fonts);

  const files: Zippable = {
    // **先頭・無圧縮。** ここを外すとリーダーが本と認識しない
    mimetype: [encode(EPUB_MIMETYPE), { level: 0 }],
    "META-INF/container.xml": encode(containerXml()),
    [`${ROOT}/content.opf`]: encode(
      contentOpf(
        book,
        chapters,
        cover,
        backCover,
        illustrations,
        characters,
        fonts,
        vertical
      )
    ),
    [`${ROOT}/${CSS_NAME}`]: encode(
      buildEpubCss(vertical, {
        bodyHref: fonts.body?.packagedName ?? null,
        headingHref: fonts.heading?.packagedName ?? null,
      })
    ),
    [`${ROOT}/${NAV_NAME}`]: encode(
      navXhtml(chapters, config, characters.length > 0, vertical)
    ),
    [`${ROOT}/${COVER_NAME}`]: encode(coverXhtml(config, cover, vertical)),
    [`${ROOT}/${TITLEPAGE_NAME}`]: encode(titlePageXhtml(config, vertical)),
    [`${ROOT}/${COLOPHON_NAME}`]: encode(colophonXhtml(config, vertical)),
  };

  if (characters.length > 0) {
    files[`${ROOT}/${CHARACTERS_NAME}`] = encode(
      buildXhtmlDocument({
        title: "登場人物",
        cssHref: CSS_NAME,
        vertical,
        body: buildCharacterPageFragment(characters.map((item) => item.entry)),
      })
    );
    for (const item of characters) {
      if (item.portrait) {
        files[`${ROOT}/${item.portrait.packagedName}`] = item.portrait.data;
      }
    }
  }

  for (const font of [fonts.body, fonts.heading]) {
    if (font) files[`${ROOT}/${font.packagedName}`] = font.data;
  }

  if (cover) files[`${ROOT}/${cover.packagedName}`] = cover.data;

  if (backCover) {
    files[`${ROOT}/${backCover.packagedName}`] = backCover.data;
    files[`${ROOT}/${BACKCOVER_NAME}`] = encode(
      buildXhtmlDocument({
        title: "裏表紙",
        cssHref: CSS_NAME,
        vertical,
        body: buildBackCoverFragment({ href: backCover.packagedName }),
      })
    );
  }

  for (const image of illustrations.values()) {
    files[`${ROOT}/${image.packagedName}`] = image.data;
  }

  for (const chapter of chapters) {
    files[`${ROOT}/${chapter.fileName}`] = encode(
      buildChapterXhtml(chapter, {
        collapseBlankLines: config.collapseBlankLines,
        cssHref: CSS_NAME,
        vertical,
        // 本の中では、挿絵は機械名で指す（`packIllustrations` を参照）
        illustrations: (chapter.illustrations ?? []).map((item) => ({
          afterParagraph: item.afterParagraph,
          href: illustrations.get(item.sourcePath)?.packagedName ?? "",
          caption: item.caption,
        })),
        pageBreaks: chapter.pageBreaks,
      })
    );
  }

  return zipSync(files);
}

/**
 * 挿絵の画像を、ZIPへ入れる形へまとめる（設計書6.65.10）。
 *
 * **名前は `illust-1.png` のような機械名に付け替える。** 表紙と同じ理由で、
 * 空白や日本語のファイル名だと画像を出さないリーダーがある。
 *
 * **同じ画像は1回だけ入れる。** 1枚の絵を章の扉として何度も使う本で、
 * 同じバイト列を人数ぶん詰めると本が重くなる。見分けは作品フォルダから
 * の相対パスで行う。
 */
function packIllustrations(
  chapters: readonly PackagedChapter[]
): Map<string, PackagedIllustration> {
  const packed = new Map<string, PackagedIllustration>();

  for (const chapter of chapters) {
    for (const item of chapter.illustrations ?? []) {
      if (packed.has(item.sourcePath)) continue;
      const index = packed.size + 1;
      packed.set(item.sourcePath, {
        id: `illust-${index}`,
        packagedName: `illust-${index}${extensionOf(item.sourcePath)}`,
        // 扱えない種類は、本を組む前に分かる言葉で断る
        mediaType: imageMediaType(item.sourcePath, "挿絵"),
        data: item.data,
      });
    }
  }

  return packed;
}

/**
 * 登場人物一覧の材料を、ZIPへ入れる形へまとめる（設計書6.65.11）。
 *
 * **イラストの名前は `portrait-1.png` の機械名に付け替える。** 表紙・挿絵と
 * 同じ理由で、空白や日本語のファイル名だと画像を出さないリーダーがある。
 *
 * **1人の絵が読めなくても、その人を落とさない。** 名前だけ載せて本は出す
 * （設計書6.65.11。挿絵と同じ流儀）。ここへ届く前に読めなかったものは
 * `icon: null` になっている。
 */
function packCharacters(
  characters: readonly EpubBookCharacter[]
): PackagedCharacter[] {
  const packed: PackagedCharacter[] = [];
  // **番号は絵の側で数える。** 人物の番号で付けると、絵の無い人が
  // 混ざったとたんに `portrait-1` の無い本ができる（読めはするが、
  // 中身を覗いた作者が「1枚目が消えた」と読む）
  let portraits = 0;

  for (const character of characters) {
    let portrait: PackagedIllustration | null = null;
    if (character.icon) {
      portraits++;
      portrait = {
        id: `portrait-${portraits}`,
        packagedName: `portrait-${portraits}${extensionOf(
          character.icon.sourcePath
        )}`,
        // 扱えない種類は、本を組む前に分かる言葉で断る
        mediaType: imageMediaType(character.icon.sourcePath, "人物イラスト"),
        data: character.icon.data,
      };
    }

    packed.push({
      entry: {
        name: character.name,
        reading: character.reading,
        summary: character.summary,
        iconHref: portrait?.packagedName ?? null,
      },
      portrait,
    });
  }

  return packed;
}

/**
 * 書体をZIPへ入れる形へまとめる（設計書6.65.11）。
 *
 * ZIPの中の名前は `font-body.<拡張子>`。**作者のファイル名は使わない**
 * （表紙・挿絵と同じ理由）。
 */
function packFonts(fonts: EpubFonts | undefined): PackagedFonts {
  return {
    body: packFont(fonts?.body ?? null, "body", "本文用の書体"),
    heading: packFont(fonts?.heading ?? null, "heading", "見出し用の書体"),
  };
}

function packFont(
  font: EpubFont | null,
  slot: "body" | "heading",
  label: string
): PackagedFont | null {
  if (!font) return null;
  return {
    id: `font-${slot}`,
    packagedName: `font-${slot}${extensionOf(font.fileName)}`,
    mediaType: fontMediaType(font.fileName, label),
    data: font.data,
  };
}

interface PackagedCharacter {
  entry: EpubCharacterEntry;
  portrait: PackagedIllustration | null;
}

interface PackagedFont {
  id: string;
  packagedName: string;
  mediaType: string;
  data: Uint8Array;
}

interface PackagedFonts {
  body: PackagedFont | null;
  heading: PackagedFont | null;
}

interface PackagedIllustration {
  id: string;
  packagedName: string;
  mediaType: string;
  data: Uint8Array;
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
  backCover: PackagedCover | null,
  illustrations: ReadonlyMap<string, PackagedIllustration>,
  characters: readonly PackagedCharacter[],
  fonts: PackagedFonts,
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
    // 挿絵は表紙ではないので `cover-image` を付けない（本に1つだけ）
    ...[...illustrations.values()].map(
      (image) =>
        `    <item id="${image.id}" href="${image.packagedName}" media-type="${image.mediaType}" />`
    ),
    // 登場人物一覧と、その人物イラスト（設計書6.65.11）
    ...(characters.length > 0
      ? [
          `    <item id="characters" href="${CHARACTERS_NAME}" media-type="application/xhtml+xml" />`,
        ]
      : []),
    ...characters
      .map((item) => item.portrait)
      .filter((portrait): portrait is PackagedIllustration => portrait !== null)
      .map(
        (portrait) =>
          `    <item id="${portrait.id}" href="${portrait.packagedName}" media-type="${portrait.mediaType}" />`
      ),
    // 同梱した書体。**manifest に無いファイルは本の中に無いのと同じ**なので、
    // ここを落とすと `@font-face` だけが残って字が変わらない
    ...[fonts.body, fonts.heading]
      .filter((font): font is PackagedFont => font !== null)
      .map(
        (font) =>
          `    <item id="${font.id}" href="${font.packagedName}" media-type="${font.mediaType}" />`
      ),
    ...chapters.map(
      (chapter) =>
        `    <item id="${chapter.id}" href="${chapter.fileName}" media-type="application/xhtml+xml" />`
    ),
    `    <item id="colophon" href="${COLOPHON_NAME}" media-type="application/xhtml+xml" />`,
    // 裏表紙の画像には `cover-image` を付けない。**本に1つだけ**と
    // 決められており、2つ付けると epubcheck で落ちる
    ...(backCover
      ? [
          `    <item id="backcover" href="${BACKCOVER_NAME}" media-type="application/xhtml+xml" />`,
          `    <item id="backcover-image" href="${backCover.packagedName}" media-type="${backCover.mediaType}" />`,
        ]
      : []),
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
    // 登場人物一覧は**目次の後・本文の前**（設計書6.65.11）。目次を出さない
    // 本でも本文の前に置く——読み始める前に人物を見せる面だからである
    ...(characters.length > 0 ? ['    <itemref idref="characters" />'] : []),
    ...chapters.map((chapter) => `    <itemref idref="${chapter.id}" />`),
    '    <itemref idref="colophon" />',
    // 裏表紙は本の最終面（設計書6.65.8）。縦書きの本は右→左に開くので、
    // 読み進んだいちばん左が裏表紙になる
    ...(backCover ? ['    <itemref idref="backcover" />'] : []),
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
  hasCharacters: boolean,
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
        charactersHref: hasCharacters ? CHARACTERS_NAME : null,
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
  /**
   * 先頭に置く登場人物一覧への行（設計書6.65.11）。null なら出さない。
   *
   * **先頭に置くのは、面が本文の前にあるから**である。目次の並びと
   * 読む順路が食い違うと、目次から飛んだ読者が戻れなくなる。
   */
  charactersHref?: string | null;
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
  // 登場人物一覧は本文の前の面なので、目次でも話より前に置く
  const characters =
    options.charactersHref === null || options.charactersHref === undefined
      ? []
      : [
          `    <li><a href="${escapeXml(
            options.charactersHref
          )}">登場人物</a></li>`,
        ];

  return [
    '<nav epub:type="toc" id="toc">',
    `<h1 class="nav-heading">目次${buildOrnamentFragment(
      options.ornament
    )}</h1>`,
    `  <ol class="${listClass}">`,
    ...characters,
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
 * 裏表紙の断片（設計書6.65.8）。
 *
 * **表紙と同じ組み方**（1枚を面いっぱいに）で、CSSも表紙のものを使い回す。
 * 文字を重ねる合成は既に画像へ焼き込まれているので、ここでは載せない。
 */
export function buildBackCoverFragment(image: { href: string }): string {
  return [
    '<div class="cover-image">',
    `<img src="${escapeXml(image.href)}" alt="裏表紙" />`,
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
export interface EpubCssFonts {
  /**
   * 本文用の書体の在りか。**呼び出し側が決める**——本ではZIPの中の
   * 機械名（`font-body.ttf`）、画面では `asWebviewUri` のURIになる
   * （挿絵・人物イラストと同じ流儀）。
   */
  bodyHref?: string | null;
  headingHref?: string | null;
}

export function buildEpubCss(
  vertical: boolean,
  fonts: EpubCssFonts = {}
): string {
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
    // 同梱した書体（設計書6.65.11）。**指定が無ければ1行も出さない**
    // ——第1段から本の見た目を変えないため
    ...fontFaces(fonts),
    ...direction,
    "body {",
    // 明朝を先に。ゴシックで組んだ小説は読み疲れる（PDF出力と同じ並び）。
    // **同梱した書体を先頭に、`serif` を最後に**置く（設計書6.65.11）。
    // フォントを読まないリーダーでも本文が消えないようにするため
    `  font-family: ${fontStack(fonts.bodyHref, BODY_FONT_FAMILY)};`,
    "  line-height: 1.8;",
    "  margin: 0;",
    "  padding: 0;",
    "}",
    "h1, h2, p { margin: 0; padding: 0; font-weight: normal; }",
    // 見出し用の書体は h1・h2 に当てる（話の見出し・目次・奥付・登場人物が
    // 全部これ）。指定が無ければ、この行そのものを出さない
    ...(fonts.headingHref
      ? [
          `h1, h2 { font-family: ${fontStack(
            fonts.headingHref,
            HEADING_FONT_FAMILY
          )}; }`,
        ]
      : []),
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
    // 挿絵（設計書6.65.10）。本文の流れに入るので、面いっぱいには広げず
    // 前後に空きを取る。解説文は画像の直後（重ねない）
    "figure { margin: 0; padding: 0; }",
    ".illustration { margin-block: 2em; text-align: center; }",
    ".illustration img { max-inline-size: 100%; max-block-size: 100%; }",
    ".illustration figcaption { font-size: 0.85em; margin-block-start: 0.6em; }",
    // 話の途中の改ページ。**古い書き方も並べる**（`page-break-before` しか
    // 見ないリーダーが現役で、片方だけだと場面が割れない）
    ".page-break {",
    "  page-break-before: always;",
    "  break-before: page;",
    "}",
    // 表紙は1枚を面いっぱいに。はみ出させない
    ".cover-image { text-align: center; margin: 0; padding: 0; }",
    ".cover-image img { max-width: 100%; max-height: 100%; }",
    ".title-page { text-align: center; margin-block-start: 20%; }",
    ".book-title { font-size: 2em; letter-spacing: 0.25em; }",
    ".book-author { margin-block-start: 3em; font-size: 1.2em; }",
    ".book-illustrator, .book-label { margin-block-start: 1em; }",
    ".nav-heading, .colophon-heading, .characters-heading {",
    "  font-size: 1.5em;",
    "  margin-block-end: 2em;",
    "}",
    ".nav-list { line-height: 2.4; }",
    // 登場人物一覧（設計書6.65.11）。1人ぶんを続けて組み、間を空ける。
    // イラストは挿絵と同じく面からはみ出させない
    ".character { margin-block-end: 2.5em; }",
    ".character-portrait { text-align: center; margin-block-end: 0.6em; }",
    ".character-portrait img { max-inline-size: 40%; max-block-size: 40%; }",
    ".character-name { font-size: 1.2em; letter-spacing: 0.05em; }",
    ".character-summary { margin-block-start: 0.5em; font-size: 0.95em; }",
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
 * 同梱した書体の宣言（設計書6.65.11）。
 *
 * **サブセット化はしない**（6.65.3）。使う字だけ抜くほうが軽くなるが、
 * 壊れたフォントを作る危険のほうが、ファイルサイズより高くつく。
 */
function fontFaces(fonts: EpubCssFonts): string[] {
  const face = (family: string, href: string): string[] => [
    "@font-face {",
    `  font-family: "${family}";`,
    `  src: url("${href}");`,
    "  font-weight: normal;",
    "  font-style: normal;",
    "}",
  ];

  return [
    ...(fonts.bodyHref ? face(BODY_FONT_FAMILY, fonts.bodyHref) : []),
    ...(fonts.headingHref ? face(HEADING_FONT_FAMILY, fonts.headingHref) : []),
  ];
}

/**
 * 書体の並び。**同梱した書体を先頭に、`serif` を最後に**置く。
 *
 * 同梱していなければ、第1段からの並びがそのまま出る（本の見た目を
 * 変えないこと）。
 */
function fontStack(href: string | null | undefined, family: string): string {
  return href ? `"${family}", ${BASE_FONT_STACK}` : BASE_FONT_STACK;
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
    // `@font-face` は選択子ではないので、**閉じ込めずにそのまま出す**
    // （`.epub-page @font-face` にすると書体そのものが読み込まれない）
    if (head.trim().startsWith("@")) {
      rules.push(`${head.trim()} {${rule[2]}}`);
      continue;
    }
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
