import { zipSync, type Zippable } from "fflate";
import {
  BOOK_BLOCK_LABELS,
  BOOK_FONT_EXTENSIONS,
  isBookImageBlock,
  resolveBookBlocks,
  type BookBlockType,
  type BookConfig,
  type BookOrnament,
  type TocEntryStyle,
  type TocPattern,
} from "../models/book";
import {
  buildChapterFragment,
  buildChapterXhtml,
  buildXhtmlDocument,
  countParagraphs,
  escapeDisplayText,
  escapeXml,
  type EpubChapterSource,
} from "./epubXhtml";
import type { NotationMode } from "./manuscriptRender";
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
const AFTERWORD_NAME = "afterword.xhtml";

/** あとがきの面の見出し。**本文の話と同じ組み方で1面にする**（6.65.15） */
export const AFTERWORD_HEADING = "あとがき";

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
  /**
   * 目次の「番号だけ」で使う章ラベル（設計書6.65.15）。
   * `episodeLabel.ts` の `formatChapterLabel` の結果をそのまま渡す。
   *
   * **話の本文側の見出し（`heading`）は変えない。** `tocEntryStyle` が
   * 効くのは目次だけで、本文の `<h2>` はいつも「番号＋題」のままにする
   * ——章の扉を開いたときに、その話がどれか分からなくなっては困る。
   */
  numberLabel?: string;
  /** 目次の「題だけ」で使う題（`episodeLabel.ts` の `episodeTitle` の結果） */
  title?: string | null;
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

/**
 * 組み立てる面1つ（設計書6.65.15）。**並びがそのまま本の並びになる。**
 *
 * `models/book.ts` の `BookBlock` と種類は同じだが、**中身を持つ**ところが
 * 違う——口絵・扉絵は画像のバイト列、あとがきは原稿の文字列である
 * （設計図はファイルの場所しか持たない。読むのは `features/exportEpub.ts`）。
 * 読めなかった面は、呼び出し側が並びから外して渡す（挿絵と同じ流儀で、
 * 1枚の失敗で本を止めない）。
 */
export type EpubBlock =
  | EpubPlainBlock
  | EpubPlateBlock
  | EpubAfterwordBlock;

/** 中身を持たない面。組み方は設計図（`BookConfig`）と本文が決める */
export interface EpubPlainBlock {
  type: Exclude<BookBlockType, "frontIllustration" | "sectionArt" | "afterword">;
}

/**
 * 画像1枚の面（口絵・扉絵）。
 *
 * **ZIPの中の名前はここで決めない**（挿絵と同じ）。中身と、同じ絵かを
 * 見分ける手がかりだけを持つ。
 */
export interface EpubPlateBlock {
  type: "frontIllustration" | "sectionArt";
  /** 作品フォルダからの相対パス。同じ絵の見分けと種類の判定に使う */
  sourcePath: string;
  data: Uint8Array;
  /** 図版の下に添える文。空なら `<figcaption>` を出さない */
  caption: string;
}

/** あとがきの面。原稿は `設定/書籍/あとがき.md`（読むのは呼び出し側） */
export interface EpubAfterwordBlock {
  type: "afterword";
  text: string;
  /** 記法。`.md` なので `curly`（`notationModeFor` の結果を渡す） */
  notation: NotationMode;
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
   * 面の並び（設計書6.65.15）。**省略すると設計図から既定の並びを組む。**
   *
   * 省略したときは口絵・扉絵・あとがきが出ない——どれも中身（画像・原稿）が
   * 要り、ここは中身を読みに行かないからである。書き出しと画面は必ず
   * 渡すこと（`features/exportEpub.ts`）。
   */
  blocks?: readonly EpubBlock[];
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
      `${label}「${fileName}」に拡張子がありません。${IMAGE_EXTENSIONS} のいずれかにしてください。`
    );
  }
  const extension = matched[1].toLowerCase();
  // **webp だけは、断る理由と直し方を言う。** 「入れられません」だけでは、
  // よく使われている形式がなぜ駄目なのか作者に伝わらない
  if (extension === "webp") {
    throw new Error(
      `${label}の種類「webp」は、EPUBのリーダーで表示できない恐れがあるため本に入れられません。` +
        "PNGかJPEGに変換してください。"
    );
  }
  const mediaType = IMAGE_MEDIA_TYPES[extension];
  if (!mediaType) {
    throw new Error(
      `${label}の種類「${extension}」は本に入れられません。${IMAGE_EXTENSIONS} のいずれかにしてください。`
    );
  }
  return mediaType;
}

/**
 * 本へ入れられる画像の種類。
 *
 * **EPUB 3.0 が中核の形式と定めているもの**から、ラスタ画像の3つを採る
 * （SVGは中身がXMLで、逃がしも検証も別物になるので扱わない）。
 *
 * **webp は入れない。** 中核の形式に入ったのは EPUB 3.3 からで、この本の
 * OPFが名乗るのは `version="3.0"` である。古いリーダーは表示できず、
 * epubcheck 4系も咎める。断るときは変換先（PNG・JPEG）まで言う。
 */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

/** 断り文で並べる種類。**受け取れないものを勧めない**ため1か所で持つ */
const IMAGE_EXTENSIONS = "png・jpg・jpeg・gif";

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
  const fonts = packFonts(book.fonts);
  // 面の並び（設計書6.65.15）。**渡されていなければ設計図から組む**
  const blocks = book.blocks ?? defaultBlocksOf(config);
  const plates = packPlates(blocks);
  // **面を出すのは「並びに置いてある」かつ「載せる人が居る」ときだけ**
  // （設計書6.65.11・6.65.15の段C）。空の一覧が1面挟まるより、無いほうが
  // よい。**元は `characterPage.enabled` を見ていた**が、段Cで並びが正に
  // なったので、チェック欄の値だけが残った本で面が消えないよう並びを見る
  const characters = blocks.some((block) => block.type === "characters")
    ? packCharacters(book.characters ?? [])
    : [];

  const packaged: PackagedBook = {
    book,
    config,
    vertical,
    blocks,
    chapters,
    cover,
    backCover,
    illustrations,
    characters,
    fonts,
    plates: plates.faces,
    plateImages: plates.images,
    // **中身の無いあとがきは面ごと出さない**（設計書6.65.15）
    afterword: afterwordOf(blocks),
  };
  const files: Zippable = {
    // **先頭・無圧縮。** ここを外すとリーダーが本と認識しない
    mimetype: [encode(EPUB_MIMETYPE), { level: 0 }],
    "META-INF/container.xml": encode(containerXml()),
    [`${ROOT}/content.opf`]: encode(contentOpf(packaged)),
    [`${ROOT}/${CSS_NAME}`]: encode(
      buildEpubCss(vertical, {
        bodyHref: fonts.body?.packagedName ?? null,
        headingHref: fonts.heading?.packagedName ?? null,
      })
    ),
    // **`nav.xhtml` は並びに目次が無くても作る**（EPUB3で必須。第1段からの
    // 約束）。並びが決めるのは「読む順路へ入れるか」だけである
    [`${ROOT}/${NAV_NAME}`]: encode(navXhtml(packaged)),
  };

  // **並びに無い面は、ファイルごと作らない**（設計書6.65.15）。読まれない
  // 面が本の中に残ると、目録との食い違いを epubcheck が咎める
  if (hasBlock(packaged, "cover")) {
    files[`${ROOT}/${COVER_NAME}`] = encode(coverXhtml(config, cover, vertical));
  }
  if (hasBlock(packaged, "halfTitle")) {
    files[`${ROOT}/${TITLEPAGE_NAME}`] = encode(titlePageXhtml(config, vertical));
  }
  if (hasBlock(packaged, "colophon")) {
    files[`${ROOT}/${COLOPHON_NAME}`] = encode(colophonXhtml(config, vertical));
  }

  if (characters.length > 0) {
    files[`${ROOT}/${CHARACTERS_NAME}`] = encode(
      buildXhtmlDocument({
        title: "登場人物",
        cssHref: CSS_NAME,
        vertical,
        body: buildCharacterPageFragment(characters.map((item) => item.entry)),
      })
    );
    for (const portrait of uniquePortraits(characters)) {
      files[`${ROOT}/${portrait.packagedName}`] = portrait.data;
    }
  }

  // 口絵・扉絵（設計書6.65.15）。面はブロックごと、画像は同じ絵なら1つ
  for (const face of plates.faces.values()) {
    files[`${ROOT}/${face.fileName}`] = encode(
      buildXhtmlDocument({
        title: face.label,
        cssHref: CSS_NAME,
        vertical,
        body: buildPlateFragment(
          { href: face.image.packagedName, caption: face.caption, label: face.label },
          vertical
        ),
      })
    );
  }
  for (const image of plates.images) {
    files[`${ROOT}/${image.packagedName}`] = image.data;
  }

  if (packaged.afterword) {
    files[`${ROOT}/${AFTERWORD_NAME}`] = encode(
      buildXhtmlDocument({
        title: AFTERWORD_HEADING,
        cssHref: CSS_NAME,
        vertical,
        body: buildAfterwordFragment(packaged.afterword, {
          collapseBlankLines: config.collapseBlankLines,
          vertical,
        }),
      })
    );
  }

  for (const font of [fonts.body, fonts.heading]) {
    if (font) files[`${ROOT}/${font.packagedName}`] = font.data;
  }

  // 表紙の画像は、表紙の面が並びに無くても入れる。**本棚に出る絵**
  // （`properties="cover-image"`）であって、面とは別の役目だからである
  if (cover) files[`${ROOT}/${cover.packagedName}`] = cover.data;

  if (showsBackCover(packaged) && backCover) {
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
 * 設計図から既定の面の並びを組む（設計書6.65.15）。
 *
 * **口絵・扉絵・あとがきは出せない。** どれも中身（画像のバイト列・原稿）が
 * 要るのに、ここはファイルを読みに行かないからである。中身を用意できるのは
 * 呼び出し側（`features/exportEpub.ts`）だけなので、そちらは必ず `blocks` を
 * 渡す。ここは第1段からの呼び出し（単体テストを含む）を壊さないための道である。
 */
function defaultBlocksOf(config: BookConfig): EpubBlock[] {
  return resolveBookBlocks(config)
    .filter((block) => !isBookImageBlock(block) && block.type !== "afterword")
    .map((block) => ({ type: block.type }) as EpubPlainBlock);
}

/**
 * 本へ入るあとがき（設計書6.65.15）。**中身が無ければ null。**
 *
 * 空かどうかは**本文と同じ数え方**（`countParagraphs`）で見る。付箋
 * （`//` で始まる行。設計書6.40）だけを書いた雛形は本へ1文字も出ないので、
 * 「まだ書いていない」と読む——見出しだけの空の面を1つ挟むほうが害が大きい。
 */
function afterwordOf(
  blocks: readonly EpubBlock[]
): EpubAfterwordBlock | null {
  const found = blocks.find(
    (block): block is EpubAfterwordBlock => block.type === "afterword"
  );
  if (!found) return null;
  return countParagraphs(found.text) > 0 ? found : null;
}

/**
 * 口絵・扉絵をZIPへ入れる形へまとめる（設計書6.65.15）。
 *
 * **画像は挿絵とまったく同じ流儀**——`plate-1.png` の機械名に付け替え、
 * 同じ絵は1回だけ入れる（1枚の絵を口絵と扉絵で使い回す本がある）。
 *
 * **面はブロックごとに1つ**である。同じ絵を2か所に置けば面は2つになる
 * （画像は1つ）ので、面の番号と画像の番号は別々に数える。
 */
function packPlates(blocks: readonly EpubBlock[]): {
  faces: Map<EpubBlock, PackagedPlate>;
  images: PackagedIllustration[];
} {
  const faces = new Map<EpubBlock, PackagedPlate>();
  const images = new Map<string, PackagedIllustration>();

  for (const block of blocks) {
    if (block.type !== "frontIllustration" && block.type !== "sectionArt") {
      continue;
    }
    const label = BOOK_BLOCK_LABELS[block.type];
    let image = images.get(block.sourcePath);
    if (!image) {
      const index = images.size + 1;
      image = {
        id: `plate-${index}`,
        packagedName: `plate-${index}${extensionOf(block.sourcePath)}`,
        // 扱えない種類は、本を組む前に分かる言葉で断る（挿絵と同じ）
        mediaType: imageMediaType(block.sourcePath, label),
        data: block.data,
      };
      images.set(block.sourcePath, image);
    }

    const faceIndex = faces.size + 1;
    faces.set(block, {
      id: `plate-page-${faceIndex}`,
      fileName: `plate-page-${faceIndex}.xhtml`,
      label,
      caption: block.caption,
      image,
    });
  }

  return { faces, images: [...images.values()] };
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
 *
 * **同じ絵は1回だけ入れる**（挿絵と同じ）。集合写真を何人もの欄に置く
 * 使い方があり、同じバイト列を人数ぶん詰めると本が重くなる。見分けは
 * 作品フォルダからの相対パスで行う。
 *
 * **名前の空の人物は届かない**（`epubCharacterPage.ts` の `selectBookCharacters`
 * が落とす）。ここで数え直さないのは、画面の注記と本の中身を同じ規則で
 * 決めるためである。
 */
function packCharacters(
  characters: readonly EpubBookCharacter[]
): PackagedCharacter[] {
  const packed: PackagedCharacter[] = [];
  // **番号は絵の側で数える。** 人物の番号で付けると、絵の無い人が
  // 混ざったとたんに `portrait-1` の無い本ができる（読めはするが、
  // 中身を覗いた作者が「1枚目が消えた」と読む）
  const portraits = new Map<string, PackagedIllustration>();

  for (const character of characters) {
    let portrait: PackagedIllustration | null = null;
    if (character.icon) {
      const sourcePath = character.icon.sourcePath;
      const known = portraits.get(sourcePath);
      if (known) {
        portrait = known;
      } else {
        const index = portraits.size + 1;
        portrait = {
          id: `portrait-${index}`,
          packagedName: `portrait-${index}${extensionOf(sourcePath)}`,
          // 扱えない種類は、本を組む前に分かる言葉で断る
          mediaType: imageMediaType(sourcePath, "人物イラスト"),
          data: character.icon.data,
        };
        portraits.set(sourcePath, portrait);
      }
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
 * ZIPへ入れる人物イラスト。**同じ絵は1つにまとめる。**
 *
 * ファイルの書き出しとOPFのmanifestが同じ並びを見るための1か所である
 * （manifest に同じidが2つ並ぶと epubcheck が咎める）。
 */
function uniquePortraits(
  characters: readonly PackagedCharacter[]
): PackagedIllustration[] {
  const seen = new Map<string, PackagedIllustration>();
  for (const item of characters) {
    if (item.portrait && !seen.has(item.portrait.id)) {
      seen.set(item.portrait.id, item.portrait);
    }
  }
  return [...seen.values()];
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

/** ZIPへ入れた口絵・扉絵の1面（画像は複数の面で共有しうる） */
interface PackagedPlate {
  id: string;
  fileName: string;
  /** 「口絵」「扉絵」。題名と代替文に使う */
  label: string;
  caption: string;
  image: PackagedIllustration;
}

/**
 * 組み立ての材料一式。
 *
 * **目録（OPF）と目次（nav）へ引数で渡さない。** 面が増えるたびに引数が
 * 増え、渡し忘れた面が「ファイルはあるのに本の中に無い」という分かりにくい
 * 壊れ方をする。1つの入れ物にして、同じものを見て組む。
 */
interface PackagedBook {
  book: EpubBook;
  config: BookConfig;
  vertical: boolean;
  blocks: readonly EpubBlock[];
  chapters: readonly PackagedChapter[];
  cover: PackagedCover | null;
  backCover: PackagedCover | null;
  illustrations: ReadonlyMap<string, PackagedIllustration>;
  characters: readonly PackagedCharacter[];
  fonts: PackagedFonts;
  /** 面ごとの口絵・扉絵。**鍵はブロックそのもの**（同じ絵でも別の面） */
  plates: ReadonlyMap<EpubBlock, PackagedPlate>;
  /** ZIPへ入れる画像（同じ絵は1つ） */
  plateImages: readonly PackagedIllustration[];
  /** 本へ入るあとがき。中身が無ければ null */
  afterword: EpubAfterwordBlock | null;
}

/** その種類の面が並びにあるか */
function hasBlock(packaged: PackagedBook, type: BookBlockType): boolean {
  return packaged.blocks.some((block) => block.type === type);
}

/** 裏表紙の面を出すか。**並びにあり、かつ画像があるとき**だけ */
function showsBackCover(packaged: PackagedBook): boolean {
  return packaged.backCover !== null && hasBlock(packaged, "backCover");
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
function contentOpf(packaged: PackagedBook): string {
  const {
    book,
    chapters,
    cover,
    backCover,
    illustrations,
    characters,
    fonts,
    vertical,
  } = packaged;
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
    // **並びに無い面は、目録にも載せない**（設計書6.65.15）。載せると
    // 本の中に読まれない面が残り、epubcheck も咎める
    ...(hasBlock(packaged, "cover")
      ? [
          `    <item id="cover" href="${COVER_NAME}" media-type="application/xhtml+xml" />`,
        ]
      : []),
    ...(hasBlock(packaged, "halfTitle")
      ? [
          `    <item id="titlepage" href="${TITLEPAGE_NAME}" media-type="application/xhtml+xml" />`,
        ]
      : []),
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
    // **同じ絵を2人で使っても1行だけ。** 同じidが2つ並ぶと epubcheck が咎める
    ...uniquePortraits(characters).map(
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
    // 口絵・扉絵（設計書6.65.15）。面はブロックごと、画像は同じ絵なら1つ
    ...[...packaged.plates.values()].map(
      (face) =>
        `    <item id="${face.id}" href="${face.fileName}" media-type="application/xhtml+xml" />`
    ),
    ...packaged.plateImages.map(
      (image) =>
        `    <item id="${image.id}" href="${image.packagedName}" media-type="${image.mediaType}" />`
    ),
    ...chapters.map(
      (chapter) =>
        `    <item id="${chapter.id}" href="${chapter.fileName}" media-type="application/xhtml+xml" />`
    ),
    ...(packaged.afterword
      ? [
          `    <item id="afterword" href="${AFTERWORD_NAME}" media-type="application/xhtml+xml" />`,
        ]
      : []),
    ...(hasBlock(packaged, "colophon")
      ? [
          `    <item id="colophon" href="${COLOPHON_NAME}" media-type="application/xhtml+xml" />`,
        ]
      : []),
    // 裏表紙の画像には `cover-image` を付けない。**本に1つだけ**と
    // 決められており、2つ付けると epubcheck で落ちる
    ...(showsBackCover(packaged) && backCover
      ? [
          `    <item id="backcover" href="${BACKCOVER_NAME}" media-type="application/xhtml+xml" />`,
          `    <item id="backcover-image" href="${backCover.packagedName}" media-type="${backCover.mediaType}" />`,
        ]
      : []),
  ];

  const spine = spineRefs(packaged).map(
    (id) => `    <itemref idref="${id}" />`
  );

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
 * 読む順路（spine）に並べる面のid（設計書6.65.15）。
 *
 * **並びの順そのままに写す。** ここが本の並びを決める唯一の場所である
 * ——面ごとに「どこへ入れるか」を書き足していくと、増やすたびに順序の
 * 決まりが散らばる。
 *
 * 出さない面の見分けは**中身があるか**で決める。人物が1人も居ない一覧、
 * 画像の無い裏表紙、中身の無いあとがきは、並びに書いてあっても出さない
 * （空の面が1つ挟まるより、無いほうがよい）。
 */
function spineRefs(packaged: PackagedBook): string[] {
  const out: string[] = [];

  for (const block of packaged.blocks) {
    switch (block.type) {
      case "cover":
        out.push("cover");
        break;
      case "halfTitle":
        out.push("titlepage");
        break;
      // **目次を外しても `nav.xhtml` は残す**（EPUB3で必須）。
      // ここで決めるのは「読む順路に並べるか」だけである
      case "toc":
        out.push("nav");
        break;
      case "characters":
        if (packaged.characters.length > 0) out.push("characters");
        break;
      case "frontIllustration":
      case "sectionArt": {
        const face = packaged.plates.get(block);
        if (face) out.push(face.id);
        break;
      }
      case "body":
        out.push(...packaged.chapters.map((chapter) => chapter.id));
        break;
      case "afterword":
        if (packaged.afterword) out.push("afterword");
        break;
      case "colophon":
        out.push("colophon");
        break;
      // 裏表紙は画像があるときだけ（設計書6.65.8）。縦書きの本は右→左に
      // 開くので、読み進んだいちばん左が裏表紙になる
      case "backCover":
        if (showsBackCover(packaged)) out.push("backcover");
        break;
    }
  }

  return out;
}

/**
 * 目次。
 *
 * `nav.xhtml` は EPUB3 の必須ファイルで、リーダーの「目次」ボタンが
 * 見るのもこれである。並びに目次が無くても作り、読む順路（`spine`）へ
 * 並べないことで「読み物としての目次ページ」だけを省く。
 *
 * **載せるのは、目次から飛ぶ値打ちのある面だけ**である（設計書6.65.15）。
 * 人物紹介・あとがき・奥付は本文と同じ読み物なので載せ、表紙・中表紙・
 * 口絵・扉絵は載せない——1行ぶん増えるだけで、読者は表紙を目次から
 * 探さない。
 */
function navXhtml(packaged: PackagedBook): string {
  const { chapters, config, vertical } = packaged;
  return buildXhtmlDocument({
    title: "目次",
    cssHref: CSS_NAME,
    vertical,
    body: buildTocFragment(
      chapters.map((chapter) => ({
        href: chapter.fileName,
        label: buildTocLabel(chapter, config.tocEntryStyle),
        group: chapter.group,
      })),
      {
        pattern: config.tocPattern,
        ornament: config.tocOrnament,
        colophonHref: hasBlock(packaged, "colophon") ? COLOPHON_NAME : null,
        charactersHref:
          packaged.characters.length > 0 ? CHARACTERS_NAME : null,
        afterwordHref: packaged.afterword ? AFTERWORD_NAME : null,
        vertical,
      }
    ),
  });
}

/**
 * 目次の1行に出す見出しの形（設計書6.65.15）。
 *
 * `numberLabel`／`title` が届いていない話（呼び出し側が古い形のまま
 * `heading` だけを渡した場合）は、いつもどおり `heading` を出す——
 * この2つは省略可能なので、渡さない使い手を壊さない。
 *
 * 番号も題もどちらも読み取れなければ `heading`、それも空なら
 * ファイル名へ倒す（空の目次行を作らない）。
 */
export function buildTocLabel(
  chapter: {
    heading: string;
    fileName: string;
    numberLabel?: string;
    title?: string | null;
  },
  style: TocEntryStyle
): string {
  if (chapter.numberLabel === undefined && chapter.title === undefined) {
    return chapter.heading.trim() || chapter.fileName;
  }
  const numberLabel = chapter.numberLabel ?? "";
  const title = chapter.title ?? "";
  const parts =
    style === "titleOnly"
      ? [title]
      : style === "numberOnly"
        ? [numberLabel]
        : [numberLabel, title];
  const joined = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("　");
  return joined || chapter.heading.trim() || chapter.fileName;
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
  /**
   * 本文の後に置くあとがきへの行（設計書6.65.15）。null なら出さない。
   *
   * **奥付より前に置く。** 目次の並びと読む順路が食い違うと、目次から
   * 飛んだ読者が本の中で迷う（人物紹介を先頭に置くのと同じ理由）。
   */
  afterwordHref?: string | null;
  /**
   * 縦書きか（設計書6.65.15）。**省略時は false**。
   *
   * 目次の行の半角の数字・「!」「?」は、縦書きの本のときだけ縦中横にする。
   */
  vertical?: boolean;
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
  const vertical = options.vertical ?? false;
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

  // あとがきは本文の後・奥付の前（本の並びと同じ順に置く）
  const afterword =
    options.afterwordHref === null || options.afterwordHref === undefined
      ? []
      : [
          `    <li><a href="${escapeXml(
            options.afterwordHref
          )}">${AFTERWORD_HEADING}</a></li>`,
        ];

  return [
    '<nav epub:type="toc" id="toc">',
    `<h1 class="nav-heading">目次${buildOrnamentFragment(
      options.ornament
    )}</h1>`,
    `  <ol class="${listClass}">`,
    ...characters,
    ...(grouped ? groupedItems(entries, vertical) : flatItems(entries, vertical)),
    ...afterword,
    ...colophon,
    "  </ol>",
    "</nav>",
  ].join("\n");
}

function flatItems(
  entries: readonly EpubTocEntry[],
  vertical: boolean
): string[] {
  return entries.map((entry) => tocItem(entry, "    ", vertical));
}

/** 目次の1行。章の中と外で字下げだけが変わる */
function tocItem(entry: EpubTocEntry, indent: string, vertical: boolean): string {
  return `${indent}<li><a href="${escapeXml(
    entry.href
  )}">${escapeDisplayText(entry.label, vertical)}</a></li>`;
}

/**
 * 章ごとに区切った並び。
 *
 * **束ね名は `<span>` で出す。** 目次の `li` の中に置けるのは
 * 「`a` か `span`、続けて `ol`」だけで、`h2` を入れると本の検証で落ちる。
 * 束ね名が続くあいだは同じ章にまとめ、変わったところで章を切る
 * （並べ替えはしない——本の順序が変わってしまう）。
 *
 * **束ね名が読めない話は、章に包まない**（設計書6.65.6）。以前は空の
 * 束ね名でも章を開いていたので、名前の無い章の見出し
 * （`<span class="toc-group"></span>`）が立っていた。**書いていない構成を
 * 本へ載せない**という約束は、章を捏造しないことと同じである。
 * 束ねられない話は一覧の項目として、その場の順序のまま置く。
 */
function groupedItems(
  entries: readonly EpubTocEntry[],
  vertical: boolean
): string[] {
  const out: string[] = [];
  /** いま開いている章の名前。null なら章の外にいる */
  let current: string | null = null;

  const closeGroup = (): void => {
    if (current === null) return;
    out.push("      </ol>", "    </li>");
    current = null;
  };

  for (const entry of entries) {
    const group = (entry.group ?? "").trim();
    if (!group) {
      closeGroup();
      out.push(tocItem(entry, "    ", vertical));
      continue;
    }
    if (group !== current) {
      closeGroup();
      current = group;
      out.push(
        `    <li><span class="toc-group">${escapeDisplayText(
          group,
          vertical
        )}</span>`,
        "      <ol>"
      );
    }
    out.push(tocItem(entry, "        ", vertical));
  }
  closeGroup();
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
 * 口絵・扉絵の断片（設計書6.65.15）。**書き出しとプレビューが共に使う。**
 *
 * **解説文は画像に重ねず、下に添える**（挿絵と同じ。設計書6.65.10）。
 * EPUBのリフロー画面では絶対配置の重ね書きがリーダーごとに崩れる。
 *
 * 表紙のように面いっぱいへ敷くのではなく、`figure` で組む——口絵は
 * 本文と同じ流れの中の1面であり、解説文が添うことがあるからである。
 */
export function buildPlateFragment(
  plate: { href: string; caption: string; label: string },
  vertical = false
): string {
  const caption = plate.caption.trim();
  return [
    '<figure class="plate">',
    // 代替文は解説文があればそれを。無ければ面の呼び名（「口絵」）——
    // **空の alt は「飾りなので読み上げなくてよい」の意味になる**。
    // 属性値なので縦中横は通さない（span を挟むと属性が壊れる）
    `<img src="${escapeXml(plate.href)}" alt="${escapeXml(
      caption || plate.label
    )}" />`,
    ...(caption
      ? [`<figcaption>${escapeDisplayText(caption, vertical)}</figcaption>`]
      : []),
    "</figure>",
  ].join("\n");
}

/**
 * あとがきの断片（設計書6.65.15）。**本文とまったく同じ組版**である。
 *
 * 話の断片（`buildChapterFragment`）をそのまま使うので、段落の詰め方も
 * ルビも傍点も縦中横も本文と同じ経路を通る——あとがき用の組み方をもう1つ
 * 書くと、本文だけ直した日から食い違い始める。
 */
export function buildAfterwordFragment(
  afterword: { text: string; notation: NotationMode },
  options: { collapseBlankLines: boolean; vertical: boolean }
): string {
  return buildChapterFragment(
    {
      heading: AFTERWORD_HEADING,
      body: afterword.text,
      notation: afterword.notation,
    },
    {
      collapseBlankLines: options.collapseBlankLines,
      vertical: options.vertical,
    }
  );
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
    body: buildColophonFragment(config, vertical),
  });
}

/**
 * 奥付の断片。書誌情報と飾りだけを組む。
 *
 * **空の項目は行ごと出さない。** 「著者　（空欄）」の並んだ奥付は、
 * 作者が書き忘れたのか、そういう本なのかが読み手に分からない。
 */
export function buildColophonFragment(
  config: BookConfig,
  vertical = false
): string {
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
      `    <dd>${escapeDisplayText(value, vertical)}</dd>`,
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
    // 半角の縦中横（設計書6.65.15）。**古いリーダー向けの書き方も並べる**
    // ——縦書き・圏点と同じ理由で、標準の書き方しか見ないリーダーがある
    ".tcy {",
    "  -epub-text-combine: horizontal;",
    "  -webkit-text-combine: horizontal;",
    "  text-combine-upright: all;",
    "}",
    // 挿絵（設計書6.65.10）。本文の流れに入るので、面いっぱいには広げず
    // 前後に空きを取る。解説文は画像の直後（重ねない）
    "figure { margin: 0; padding: 0; }",
    ".illustration { margin-block: 2em; text-align: center; }",
    ".illustration img { max-inline-size: 100%; max-block-size: 100%; }",
    ".illustration figcaption { font-size: 0.85em; margin-block-start: 0.6em; }",
    // 口絵・扉絵（設計書6.65.15）。**それだけで1面**なので、挿絵のように
    // 前後の空きは取らず、面いっぱいに収まる大きさへ納める
    ".plate { margin: 0; padding: 0; text-align: center; }",
    ".plate img { max-inline-size: 100%; max-block-size: 100%; }",
    ".plate figcaption { font-size: 0.85em; margin-block-start: 0.6em; }",
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
