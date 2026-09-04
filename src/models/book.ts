/**
 * 本の設計図（設計書6.65.2）。
 *
 * 書誌情報・綴じ方向・目次の有無・表紙——**作者が編集するもの**を1つの
 * JSONに集める。置き場所は `設定/書籍/book.json`（`設定/` はGitで同期・
 * 復元できる。EPUB そのものは本文と設定資料から作り直せるので同期しない）。
 *
 * **画像は埋め込まず、作品フォルダからの相対パスで参照する。** JSONへ
 * base64 で入れると、1文字直すたびに数百KBの差分がGitへ積まれる。
 *
 * VS Code API に依存しない（`models` の約束）。第1段（6.65.4）の項目に、
 * 第3段の前半で表紙・裏表紙の合成指定（6.65.8）を、後半の前側で挿絵と
 * ページ分割（6.65.10）を、後側で登場人物一覧と書体（6.65.11）を足した。
 */

import {
  invalid,
  objectValue,
  optionalBoolean,
  optionalEnum,
  optionalNullableString,
  optionalObjectArray,
  optionalString,
  requireNonEmptyString,
} from "./jsonValidation";

/** 綴じ方向。縦書きなら右→左、横書きなら左→右に開く */
export type BookWritingMode = "vertical" | "horizontal";

export const BOOK_WRITING_MODES: readonly BookWritingMode[] = [
  "vertical",
  "horizontal",
];

/**
 * 目次ページの並べ方（設計書6.65.6）。
 *
 * - `vertical`：**本文と同じ流れ**の一覧（縦組みの本なら縦に並ぶ）。既定
 * - `horizontal`：目次だけ横組みにする（縦組みの本でもここは横に読む）
 * - `chapters`：章ごとに区切り、章の見出しを立てる
 *
 * **`vertical` を「必ず縦組み」にしていない。** 横組みの本で既定のまま
 * 目次だけ縦になると、作者が何も選んでいないのに見た目が変わる。
 * 既定は「いままでどおり」でなければならない（0.29.18の実装で決めた）。
 */
export type TocPattern = "vertical" | "horizontal" | "chapters";

export const TOC_PATTERNS: readonly TocPattern[] = [
  "vertical",
  "horizontal",
  "chapters",
];

/**
 * 目次の1行に出す見出しの形（設計書6.65.15）。
 *
 * - `numberAndTitle`：番号＋題（既定。いままでどおりの見た目）
 * - `titleOnly`：題だけ
 * - `numberOnly`：番号だけ
 *
 * **既定を変えない。** 重複除去（`episodeLabel.ts` の `stripChapterLabel`）
 * を先に直したので、既定のままでも「第1話　第1話」のような二重は
 * 出なくなる——この選択肢は、それでも番号や題だけにしたい作者のためのもの。
 */
export type TocEntryStyle = "numberAndTitle" | "titleOnly" | "numberOnly";

export const TOC_ENTRY_STYLES: readonly TocEntryStyle[] = [
  "numberAndTitle",
  "titleOnly",
  "numberOnly",
];

/**
 * 目次・奥付の飾り（設計書6.65.6）。
 *
 * **画像ファイルは増やさない。** `rule` はCSSの罫線、`center` は断片の
 * 中に書いたSVGである。外部ファイルにすると、OPFのmanifestへ載せ忘れた
 * ときに「本は開くが飾りだけ出ない」という分かりにくい壊れ方をする。
 */
export type BookOrnament = "none" | "rule" | "center";

export const BOOK_ORNAMENTS: readonly BookOrnament[] = [
  "none",
  "rule",
  "center",
];

/**
 * 表紙に重ねる文字の置き場所（設計書6.65.8）。
 *
 * 上・中・下 × 左・中央・右の**9か所のプリセット**である。自由ドラッグに
 * すると book.json に座標の小数が並び、差分が読めなくなるうえ、同じ本を
 * 2台で直したときの同期の衝突が増える。
 */
export type CoverAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export const COVER_ANCHORS: readonly CoverAnchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

/**
 * 字の大きさ。**ポイント数では持たない。**
 *
 * 元イラストの寸法は作品ごとに違うので、絶対値で持つと同じ「24」が
 * ある本では大見出し、別の本では読めない小ささになる。焼くときに
 * 画像の短い辺からの割合として使う（`views/epubEditorPanelHtml.ts`）。
 */
export type CoverTextSize = "large" | "medium" | "small";

export const COVER_TEXT_SIZES: readonly CoverTextSize[] = [
  "large",
  "medium",
  "small",
];

/** 表紙に重ねられる4つの要素。書誌情報の4項目と1対1で対応する */
export const COVER_ELEMENT_KEYS = [
  "title",
  "author",
  "illustrator",
  "label",
] as const;

export type CoverElementKey = (typeof COVER_ELEMENT_KEYS)[number];

export interface CoverTextStyle {
  /** 出すか。**出さない指定も残す**（消すと、戻すたびに置き場所を選び直すことになる） */
  visible: boolean;
  anchor: CoverAnchor;
  size: CoverTextSize;
  /** `#ffffff` の形。白・黒は画面のボタンで選び、それ以外は16進で書く */
  color: string;
  vertical: boolean;
}

/**
 * 1枚の表紙ぶんの合成指定。
 *
 * **`frameBackground` は文字要素ではなく枠そのものの色**（設計書6.65.15）。
 * 表紙・裏表紙の枠は横1：縦1.4に固定し、元イラストが枠と違う比率のときは
 * 縮めて中央に納め、余った部分をこの色で塗る。
 */
export type CoverLayout = Record<CoverElementKey, CoverTextStyle> & {
  /** 余白の色。`#ffffff` の形。白・黒は画面のボタンで選び、それ以外は16進 */
  frameBackground: string;
};

/**
 * 本文の中の位置（設計書6.65.10）。挿絵とページ分割が共に使う。
 *
 * **話は番号ではなくファイルの相対パスで指す。** 話数は並べ替えや改題で
 * 動くが、パスはその話そのものを指し続ける。
 *
 * **段落は「詰める前の段落番号」**（空行で区切った塊）で数える。
 * `collapseBlankLines` を切り替えたとたんに挿絵が別の場面へ移る、という
 * ことが起きないようにするためである。数え方の実装は
 * `core/epubXhtml.ts` の `countParagraphs` が1か所で持つ。
 */
export interface BookBodyPosition {
  /** 作品フォルダからの相対パス（区切りは `/` に揃える） */
  episodePath: string;
  /** 第M段落のあと。1以上 */
  afterParagraph: number;
}

/** 本文の途中に入れる挿絵（設計書6.65.10） */
export interface BookIllustration extends BookBodyPosition {
  /** 画像。作品フォルダからの相対パス（表紙とまったく同じ検証） */
  imagePath: string;
  /**
   * 解説文。空なら `<figcaption>` そのものを出さない。
   *
   * **画像の上には重ねない。** EPUBのリフロー画面では絶対配置の重ね書きが
   * リーダーごとに崩れる（設計書6.65.10）。
   */
  caption: string;
}

/** 話の途中で改ページする位置（場面替わり用。設計書6.65.10） */
export type BookPageBreak = BookBodyPosition;

/**
 * 登場人物一覧の面を出すか（設計書6.65.11）。
 *
 * **既定は「出さない」。** 設定資料には本文からAIが読み取ったものが
 * 混ざっており、確かめていない記述やネタバレが不意に本へ入るのは事故で
 * ある。作者がここで選んで初めて面が増える。
 */
export interface BookCharacterPage {
  /**
   * **いまは読み込み互換のためだけの項目**（設計書6.65.15の段C）。
   * 面を出すかは `blocks` に置いてあるかどうかが決める。`tocEnabled` と
   * 同じ扱いで、画面からは書き換えない。
   */
  enabled: boolean;
  /** 人物イラスト（台帳の `icon`）を添えるか。読めない人物は名前だけ */
  showIcons: boolean;
}

/**
 * 同梱する書体（設計書6.65.11）。
 *
 * **枠は本文用と見出し用の2つだけ。** 増やすより、まず2枠で足りるかを
 * 実機で見る。どちらも作品フォルダの中の .ttf／.otf への相対パスで、
 * null なら同梱しない（＝リーダー側の明朝で組まれる）。
 *
 * **埋め込みが許諾されているかは作者の責任である**（6.65.3）。ここでは
 * 判定できないので、選択欄に注意書きを常に出す。
 */
export interface BookFonts {
  body: string | null;
  heading: string | null;
}

/**
 * 本へ入れられる書体の種類。
 *
 * **`.woff`／`.woff2` は入れない。** EPUB3の必須形式ではあるが、作者が
 * 手元に持っているのはたいてい .ttf か .otf であり、変換して壊れた
 * フォントを本へ入れるより、扱える種類を絞って断るほうがよい
 * （サブセット化をしないと決めたのと同じ考え方）。
 */
export const BOOK_FONT_EXTENSIONS: readonly string[] = ["ttf", "otf"];

/**
 * 本を組み立てる「面」の種類（設計書6.65.15）。
 *
 * **並びがそのまま本の並びになる。** 種類ごとの設定は最小限で、
 * 中身（書誌情報・目次の体裁・人物の絞り込み）は従来どおり `BookConfig` の
 * 各項目が持つ——ここへ写すと、同じ設定が2か所にある状態になる。
 *
 * **章区切りは持たない**（設計書6.65.15）。章立ての台帳（`設定/章立て.json`。
 * 6.66）が正で、二重管理にしない。
 */
export const BOOK_BLOCK_TYPES = [
  /** 表紙 */
  "cover",
  /** 中表紙（タイトルページ） */
  "halfTitle",
  /** 口絵（本文の前に置く画像の面） */
  "frontIllustration",
  /** 扉絵（任意の位置に挿せる画像の面） */
  "sectionArt",
  "toc",
  /** 人物紹介 */
  "characters",
  /** 本文一式。**1冊にちょうど1つ** */
  "body",
  "afterword",
  /** 奥付 */
  "colophon",
  "backCover",
] as const;

export type BookBlockType = (typeof BOOK_BLOCK_TYPES)[number];

/** 画像1枚で1面になる種類。口絵と扉絵は**置ける場所だけが違う** */
export const BOOK_IMAGE_BLOCK_TYPES = [
  "frontIllustration",
  "sectionArt",
] as const;

export type BookImageBlockType = (typeof BOOK_IMAGE_BLOCK_TYPES)[number];

/** 面の呼び名。**通知にも画面にも同じ言葉を出す**ため1か所で持つ */
export const BOOK_BLOCK_LABELS: Record<BookBlockType, string> = {
  cover: "表紙",
  halfTitle: "中表紙",
  frontIllustration: "口絵",
  sectionArt: "扉絵",
  toc: "目次",
  characters: "人物紹介",
  body: "本文",
  afterword: "あとがき",
  colophon: "奥付",
  backCover: "裏表紙",
};

/** 画像の面（口絵・扉絵）。場所の検証は表紙・挿絵とまったく同じ */
export interface BookImageBlock {
  type: BookImageBlockType;
  /** 作品フォルダからの相対パス */
  imagePath: string;
  /** 図版の下に添える文。空なら出さない（挿絵と同じ） */
  caption: string;
}

/** 画像以外の面。**種類のほかに持つものが無い**（設定は BookConfig 側） */
export interface BookPlainBlock {
  type: Exclude<BookBlockType, BookImageBlockType>;
}

export type BookBlock = BookImageBlock | BookPlainBlock;

/** 画像の面か（型を絞るためだけの判定。並び替えの都合で何度も要る） */
export function isBookImageBlock(block: BookBlock): block is BookImageBlock {
  return (BOOK_IMAGE_BLOCK_TYPES as readonly string[]).includes(block.type);
}

/**
 * 1冊に1つまでの面。
 *
 * 扉絵（`sectionArt`）だけは何枚でも挿せる——章の変わり目ごとに絵を置く
 * 使い方があり、そこを縛ると本が作れなくなる。口絵も同じ理由で複数を許す。
 *
 * **組み替え画面の「この後ろに挿入」も、この表を見て行を出す**（設計書
 * 6.65.15の段D）。「置けない種類を選べてしまい、保存のときに初めて
 * 断られる」を作らないため、判断の元は1か所に置く。
 */
export const BOOK_SINGLE_BLOCK_TYPES: readonly BookBlockType[] = [
  "cover",
  "halfTitle",
  "toc",
  "characters",
  "body",
  "afterword",
  "colophon",
  "backCover",
];

export interface BookConfig {
  schemaVersion: string;
  /** 題名。空なら作品名で埋める（無題の本を作らない） */
  title: string;
  author: string;
  illustrator: string;
  /** レーベル名。奥付と `dc:publisher` に出る */
  label: string;
  writingMode: BookWritingMode;
  /**
   * 読み物としての目次ページを入れるか。
   *
   * **いまは読み込み互換のためだけの項目である**（設計書6.65.15の段C）。
   * 目次の面を入れるかは `blocks` に置いてあるかどうかが決めるので、
   * ここを見るのは「blocks を持たない古い book.json から既定の並びを
   * 組む」ときだけになった。**画面からは書き換えない**（作者が手で書いた
   * 値を、並びの編集のついでに塗り替えないため）。
   */
  tocEnabled: boolean;
  /** 目次ページの並べ方。`tocEnabled` が false なら見た目に影響しない */
  tocPattern: TocPattern;
  /** 目次の1行に出す見出しの形（設計書6.65.15）。既定は番号＋題 */
  tocEntryStyle: TocEntryStyle;
  /** 目次ページの飾り */
  tocOrnament: BookOrnament;
  /** 奥付の飾り。目次とは別に選べる（片方だけ飾りたいことがある） */
  colophonOrnament: BookOrnament;
  /**
   * 続いた空行を1つ減らすか（設計書6.65.2「改行が2つ並んでいたら1つに」）。
   *
   * Webの作法では段落ごとに1行空けるが、本にすると隙間だらけになる。
   * かといって全部消すと場面の切り替わりが消えるので、**1つ減らす**。
   * 詰め方の詳細は `core/epubXhtml.ts` に書いた。
   */
  collapseBlankLines: boolean;
  /** 表紙画像。作品フォルダからの相対パス。無ければ文字だけの扉になる */
  coverImagePath: string | null;
  /**
   * 裏表紙の元イラスト。作品フォルダからの相対パス（表紙と同じ検証）。
   *
   * **本へ入るのは合成して焼いた `裏表紙_合成済み.png` だけ**である
   * （設計書6.65.8）。ここはエディター画面で下絵として読むためにある。
   */
  backCoverImagePath: string | null;
  /** 表紙の合成指定。**焼いた画像が無ければ書き出しの見た目は変わらない** */
  coverLayout: CoverLayout;
  /** 裏表紙の合成指定。表紙とは別に持つ（同じ体裁とは限らない） */
  backCoverLayout: CoverLayout;
  /**
   * 本文へ挟む挿絵（設計書6.65.10）。**原稿には目印を書き込まない。**
   *
   * 位置がずれること（原稿を書き足した・段落を削った）は防げないが、
   * 検知はできる。書き出しとプレビューの両方で、段落数を超えた指定を
   * 警告して末尾へ置く。
   */
  illustrations: BookIllustration[];
  /** 話の途中の改ページ。XHTMLは分けず、次の段落にクラスを付ける */
  pageBreaks: BookPageBreak[];
  /** 登場人物一覧（設計書6.65.11）。**既定は出さない** */
  characterPage: BookCharacterPage;
  /** 同梱する書体（設計書6.65.11）。既定はどちらも null（同梱しない） */
  fonts: BookFonts;
  /**
   * 面の並び（設計書6.65.15）。**順序がそのまま本の並びになる。**
   *
   * **省略できる。** blocks を知らない版で書かれた book.json をそのまま
   * 読めるようにするためで、読み込み時に既定の並びを組んで補う
   * （`parseBookConfig`）。**ファイルは書き換えない**——保存して初めて
   * この項目が book.json へ入る。
   *
   * 使う側は必ず `resolveBookBlocks` を通すこと（書いていない本のために
   * 既定の並びを組むのはそこ1か所である）。**段Cからはここが正**で、
   * 目次・人物紹介の設定に追従させない。
   */
  blocks?: BookBlock[];
}

export const BOOK_SCHEMA_VERSION = "0.1";
/** `設定/` の下のフォルダ名 */
export const BOOK_DIR = "書籍";
export const BOOK_FILE = "book.json";
/**
 * あとがきの原稿（設計書6.65.15）。
 *
 * **JSONではなくMarkdownで持つ。** 長い文章をJSONへ入れると、改行が
 * `\n` の並びになって作者が読めず、Gitの差分も1行にまとまる。
 * `設定/書籍/` に置くので、`設定/` と一緒に同期・復元できる。
 */
export const AFTERWORD_FILE = "あとがき.md";

/**
 * 表紙の合成の既定（設計書6.65.8）。
 *
 * 題名を上・中央に大きく、作者名を下・右に。**どちらも縦書き・白**——
 * 日本語の小説の表紙でいちばん多い置き方であり、暗いイラストの上でも
 * 読める。絵師名とレーベル名は**出さない**：書いていない作品のほうが
 * 多く、空の項目を勝手に載せると「イラスト　」だけが焼き込まれる。
 *
 * **この既定値は書き出しの見た目を変えない。** 合成が本へ入るのは
 * 「焼いた画像」がある本だけで、焼くのは作者が押したときだけである。
 */
export function defaultCoverLayout(): CoverLayout {
  return {
    title: {
      visible: true,
      anchor: "top-center",
      size: "large",
      color: "#ffffff",
      vertical: true,
    },
    author: {
      visible: true,
      anchor: "bottom-right",
      size: "medium",
      color: "#ffffff",
      vertical: true,
    },
    illustrator: {
      visible: false,
      anchor: "bottom-left",
      size: "small",
      color: "#ffffff",
      vertical: true,
    },
    label: {
      visible: false,
      anchor: "bottom-center",
      size: "small",
      color: "#ffffff",
      vertical: false,
    },
    // **既定は黒**（作者の指定、2026-09-03）。白イラストの余白が
    // 目立たないよう、黒を既定にしておく
    frameBackground: "#000000",
  };
}

/**
 * 裏表紙の合成の既定。
 *
 * **何も出さない。** 裏表紙は絵だけのことが多く、題名や作者名は表紙と
 * 奥付に既にある。出したい人が選べばよい（置き場所の既定だけは、
 * 選んだ瞬間に妥当な場所へ出るよう入れてある）。
 */
export function defaultBackCoverLayout(): CoverLayout {
  const layout = defaultCoverLayout();
  return {
    title: { ...layout.title, visible: false },
    author: { ...layout.author, visible: false },
    illustrator: { ...layout.illustrator, visible: false },
    label: { ...layout.label, visible: false },
    frameBackground: layout.frameBackground,
  };
}

/**
 * 既定の面の並び（設計書6.65.15）。**純粋関数**である。
 *
 * blocks を持たない book.json を、**いままでと同じ本**として読むための
 * 並びでもある（表紙→中表紙→目次→人物紹介→本文→奥付→裏表紙）。
 *
 * ## あとがきを既定の並びに入れている
 *
 * 設計書の並びにあとがきは無いが、**原稿（`設定/書籍/あとがき.md`）が
 * 無ければ面ごと出ない**ので、いままでの本の中身は1文字も変わらない。
 * 入れておかないと、あとがきを書く入口だけあって本に載らない——並びを
 * 編む画面（段C）ができるまで、作者にできることが無くなってしまう。
 *
 * ## 裏表紙は「有無」で足し引きしない
 *
 * 裏表紙の面が本へ入るかは、**焼いた画像か元イラストがあるか**で決まる
 * （設計書6.65.8の拾い順）。`backCoverImagePath` だけを見て並びから外すと、
 * 焼いた画像しか無い本の裏表紙が消える。並びには常に置き、画像が無ければ
 * 組み立て側が面を出さない。
 */
export function defaultBookBlocks(settings: {
  tocEnabled: boolean;
  characterPage: { enabled: boolean };
}): BookBlock[] {
  return [
    { type: "cover" },
    { type: "halfTitle" },
    ...(settings.tocEnabled ? [{ type: "toc" } as BookPlainBlock] : []),
    ...(settings.characterPage.enabled
      ? [{ type: "characters" } as BookPlainBlock]
      : []),
    { type: "body" },
    { type: "afterword" },
    { type: "colophon" },
    { type: "backCover" },
  ];
}

/**
 * 実際に組む面の並び（設計書6.65.15）。**書き出しも画面もここを通す。**
 *
 * ## 並びが正である（段C、本体の裁定）
 *
 * 段Bまでは「目次・人物紹介のチェック欄が正」で、ここで欄の値へ blocks を
 * 追従させていた（並びを編む画面がまだ無かったため）。段Cで組み替え画面が
 * できたので、**書いてある並びをそのまま返す**。追従を残すと、画面で外した
 * 目次が古いチェックの値で戻ってきて、**作者が並べたとおりの本にならない**
 * ——二重管理をここで断つ。
 *
 * `tocEnabled`・`characterPage.enabled` は**読み込み互換のためだけ**に残る
 * （blocks を持たない古い book.json から既定の並びを組む材料。`BookConfig`
 * の項目の説明も参照）。
 */
export function resolveBookBlocks(config: BookConfig): BookBlock[] {
  return config.blocks ? [...config.blocks] : defaultBookBlocks(config);
}

/** 1冊に1つまでの面か（パレットで押せなくする判断に使う） */
export function isSingleBookBlockType(type: BookBlockType): boolean {
  return BOOK_SINGLE_BLOCK_TYPES.includes(type);
}

/**
 * その種類を、いまの並びへもう1つ置けるか（設計書6.65.15の段C）。
 *
 * 口絵・扉絵は何枚でも置ける。1冊に1つの面は、既にあれば置けない
 * （本文もここに入るので、複製そのものができない）。
 */
export function canAddBookBlock(
  blocks: readonly BookBlock[],
  type: BookBlockType
): boolean {
  if (!isSingleBookBlockType(type)) return true;
  return !blocks.some((block) => block.type === type);
}

/**
 * その位置の面を消せるか。**本文だけは消せない**（1冊にちょうど1つ）。
 *
 * 消せない理由を画面で組み立てずに済むよう、判断はここに置く
 * （`assertBlockCounts` が断る形と、画面の押せなさを一致させる）。
 */
export function canRemoveBookBlock(
  blocks: readonly BookBlock[],
  index: number
): boolean {
  const block = blocks[index];
  return block !== undefined && block.type !== "body";
}

/**
 * 選んだ面の**後ろへ**1つ挿す（設計書6.65.15の段C）。
 *
 * **置けないときは null を返す。** 呼び出し側が理由を作者へ伝えられるよう、
 * 黙って何もしない（＝押しても無反応）にはしない。選択が無い（負の値）
 * ときは末尾へ置く。
 */
export function insertBookBlockAfter(
  blocks: readonly BookBlock[],
  index: number,
  block: BookBlock
): BookBlock[] | null {
  if (!canAddBookBlock(blocks, block.type)) return null;
  const out = [...blocks];
  const at = index < 0 || index >= out.length ? out.length : index + 1;
  out.splice(at, 0, block);
  return out;
}

/**
 * 面を1つ上（`-1`）／下（`+1`）へ動かす。
 *
 * **端では null。** 右クリックのメニューから押す操作なので（設計書6.65.15の
 * 段D。ドラッグが苦手な人の道として残してある）、押せない場所は画面側でも
 * 押せなくする——その判断をここと共有する。
 */
export function moveBookBlock(
  blocks: readonly BookBlock[],
  index: number,
  direction: -1 | 1
): BookBlock[] | null {
  const to = index + direction;
  if (index < 0 || index >= blocks.length) return null;
  if (to < 0 || to >= blocks.length) return null;

  const out = [...blocks];
  const [moved] = out.splice(index, 1);
  out.splice(to, 0, moved);
  return out;
}

/**
 * 掴んだ面を、別の隙間へ落とす（設計書6.65.15の段D。作者の指定）。
 *
 * `before` は**落とし先の隙間の番号**である。0 は先頭、`blocks.length` は
 * 末尾で、`n` は「いま n 番目にある面の手前」を指す。画面が測るのは
 * 「どの行のどちら側で離したか」だけで、**並びの計算はここが持つ**
 * ——ドラッグの見え方は実機でしか確かめられないが、並びの変化はここで
 * 固定できる（段Dでドラッグを入れるときの、いちばんの心配ごと）。
 *
 * **何も変わらないときは null を返す。** 自分自身の上（前の隙間でも後ろの
 * 隙間でも並びは同じ）と範囲の外は「動かさなかった」と同じに扱う。Escで
 * 取りやめたときや枠の外で離したときに、並びが黙って変わらないための砦。
 */
export function dropBookBlock(
  blocks: readonly BookBlock[],
  from: number,
  before: number
): BookBlock[] | null {
  if (from < 0 || from >= blocks.length) return null;
  if (before < 0 || before > blocks.length) return null;

  // 掴んだ面を抜いたあとの位置へ直す（後ろへ動かすときは1つ手前になる）
  const to = before > from ? before - 1 : before;
  if (to === from) return null;

  const out = [...blocks];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** 面を1つ消す。**本文は消せない**（`canRemoveBookBlock`）ので null */
export function removeBookBlockAt(
  blocks: readonly BookBlock[],
  index: number
): BookBlock[] | null {
  if (!canRemoveBookBlock(blocks, index)) return null;
  return blocks.filter((_, position) => position !== index);
}

export function defaultBookConfig(title: string): BookConfig {
  return {
    schemaVersion: BOOK_SCHEMA_VERSION,
    title: title.trim(),
    author: "",
    illustrator: "",
    label: "",
    // 日本語の小説は縦書きが既定。横書きは作者が選んだときだけ
    writingMode: "vertical",
    tocEnabled: true,
    // **既定は「いままでどおりの見た目」。** 第1段で書き出した本と
    // 同じものが出ないと、版を上げただけで本の体裁が変わる
    tocPattern: "vertical",
    // **既定は「番号＋題」**（いままでどおりの見た目。重複除去のあとの形）
    tocEntryStyle: "numberAndTitle",
    tocOrnament: "none",
    colophonOrnament: "none",
    collapseBlankLines: true,
    coverImagePath: null,
    backCoverImagePath: null,
    coverLayout: defaultCoverLayout(),
    backCoverLayout: defaultBackCoverLayout(),
    // 挿絵もページ分割も、指定するまでは何も起きない（既定の本の
    // 見た目を変えないこと。ほかの項目と同じ約束）
    illustrations: [],
    pageBreaks: [],
    // **登場人物一覧は既定で出さない**（設計書6.65.11）。ただし出すと
    // 決めた人はたいてい顔も見せたいので、イラストの側は既定で入れる
    characterPage: { enabled: false, showIcons: true },
    fonts: { body: null, heading: null },
    // 面の並び（設計書6.65.15）。**いままでの本と同じ並び**である
    blocks: defaultBookBlocks({
      tocEnabled: true,
      characterPage: { enabled: false },
    }),
  };
}

/**
 * 作者が手で書いたJSONを読む。
 *
 * **壊れていたら例外を投げる。** 勝手に直して上書きすると、作者が書いた
 * 値が黙って消える（他の台帳と同じ約束）。書かれていない項目は既定値で
 * 埋める——第1段では book.json を書く画面が無く、**無い状態から1回
 * 書き出せる**ことのほうが大事である。
 *
 * @param workTitle 題名が書かれていないときに使う作品名
 */
export function parseBookConfig(raw: unknown, workTitle: string): BookConfig {
  const value = objectValue(raw, "設定/書籍/book.json");
  const defaults = defaultBookConfig(workTitle);

  // **schemaVersion だけを特別扱いしない。** ここだけ「文字列でなければ
  // 既定へ倒す」だったので、`schemaVersion: 2` と書いた設計図が黙って
  // 既定の版として組まれていた（作者は指定が効いていないことに気づけない）
  optionalString(value.schemaVersion, "schemaVersion");
  optionalString(value.title, "title");
  optionalString(value.author, "author");
  optionalString(value.illustrator, "illustrator");
  optionalString(value.label, "label");
  optionalEnum(value.writingMode, "writingMode", BOOK_WRITING_MODES);
  optionalBoolean(value.tocEnabled, "tocEnabled");
  optionalEnum(value.tocPattern, "tocPattern", TOC_PATTERNS);
  optionalEnum(value.tocEntryStyle, "tocEntryStyle", TOC_ENTRY_STYLES);
  optionalEnum(value.tocOrnament, "tocOrnament", BOOK_ORNAMENTS);
  optionalEnum(value.colophonOrnament, "colophonOrnament", BOOK_ORNAMENTS);
  optionalBoolean(value.collapseBlankLines, "collapseBlankLines");
  optionalNullableString(value.coverImagePath, "coverImagePath");
  optionalNullableString(value.backCoverImagePath, "backCoverImagePath");

  const title = ((value.title as string | undefined) ?? "").trim();

  return {
    schemaVersion:
      (value.schemaVersion as string | undefined) ?? BOOK_SCHEMA_VERSION,
    // 空白だけの題名は「書いていない」と同じに扱う
    title: title || defaults.title,
    author: ((value.author as string | undefined) ?? defaults.author).trim(),
    illustrator: (
      (value.illustrator as string | undefined) ?? defaults.illustrator
    ).trim(),
    label: ((value.label as string | undefined) ?? defaults.label).trim(),
    writingMode:
      (value.writingMode as BookWritingMode | undefined) ??
      defaults.writingMode,
    tocEnabled:
      (value.tocEnabled as boolean | undefined) ?? defaults.tocEnabled,
    tocPattern:
      (value.tocPattern as TocPattern | undefined) ?? defaults.tocPattern,
    tocEntryStyle:
      (value.tocEntryStyle as TocEntryStyle | undefined) ??
      defaults.tocEntryStyle,
    tocOrnament:
      (value.tocOrnament as BookOrnament | undefined) ?? defaults.tocOrnament,
    colophonOrnament:
      (value.colophonOrnament as BookOrnament | undefined) ??
      defaults.colophonOrnament,
    collapseBlankLines:
      (value.collapseBlankLines as boolean | undefined) ??
      defaults.collapseBlankLines,
    coverImagePath: coverPath(value.coverImagePath, "表紙"),
    backCoverImagePath: coverPath(value.backCoverImagePath, "裏表紙"),
    coverLayout: parseCoverLayout(
      value.coverLayout,
      "coverLayout",
      defaults.coverLayout
    ),
    backCoverLayout: parseCoverLayout(
      value.backCoverLayout,
      "backCoverLayout",
      defaults.backCoverLayout
    ),
    illustrations: parseIllustrations(value.illustrations),
    pageBreaks: parsePageBreaks(value.pageBreaks),
    // **blocks が無ければ、いまの設定から既定の並びを組む**（設計書
    // 6.65.15）。ここで組んでもファイルは書き換わらない——保存して初めて
    // book.json に入る
    blocks:
      parseBlocks(value.blocks) ??
      defaultBookBlocks({
        tocEnabled:
          (value.tocEnabled as boolean | undefined) ?? defaults.tocEnabled,
        characterPage: parseCharacterPage(
          value.characterPage,
          defaults.characterPage
        ),
      }),
    characterPage: parseCharacterPage(
      value.characterPage,
      defaults.characterPage
    ),
    fonts: parseFonts(value.fonts),
  };
}

/**
 * 面の並びを読む（設計書6.65.15）。**書いていなければ undefined。**
 *
 * 呼び出し側が「書いていない」と「空の並び（面が1つも無い本）」を
 * 見分けられるようにしてある——空の並びは本文の無い本なので、下の検査で
 * 断る。既定の並びで補うのは、項目そのものが無いときだけである。
 */
function parseBlocks(raw: unknown): BookBlock[] | undefined {
  const blocks = optionalObjectArray(raw, "blocks", (entry, entryPath) => {
    requireNonEmptyString(entry.type, `${entryPath}.type`);
    const type = (entry.type as string).trim();
    // **知らない種類は受け取らない。** 既定へ倒すと、書いた面と違うものが
    // 黙って本へ入る（表紙の合成指定と同じ約束）
    if (!(BOOK_BLOCK_TYPES as readonly string[]).includes(type)) {
      throw new Error(
        `${entryPath}.type「${type}」は知らない面の種類です。` +
          `${BOOK_BLOCK_TYPES.join("・")} のいずれかにしてください。`
      );
    }

    if ((BOOK_IMAGE_BLOCK_TYPES as readonly string[]).includes(type)) {
      const label = BOOK_BLOCK_LABELS[type as BookBlockType];
      // 絵の無い口絵・扉絵は作らない（挿絵と同じ理由）
      requireNonEmptyString(entry.imagePath, `${entryPath}.imagePath`);
      optionalString(entry.caption, `${entryPath}.caption`);
      return {
        type: type as BookImageBlockType,
        // 表紙・挿絵とまったく同じ検証を通す（片方だけ緩くしない）
        imagePath: relativeInsideWork((entry.imagePath as string).trim(), label),
        caption: ((entry.caption as string | undefined) ?? "").trim(),
      };
    }

    return { type: type as BookPlainBlock["type"] };
  });

  if (!blocks) return undefined;
  assertBlockCounts(blocks);
  return blocks;
}

/**
 * 並びとして成り立っているか。
 *
 * **本文はちょうど1つ**——0では本にならず、2つあると同じ話が二度入る。
 * 表紙や奥付のように1冊に1つしかない面も、重ねて書けない（どちらの設定が
 * 効いたのか分からない本ができる）。
 */
function assertBlockCounts(blocks: readonly BookBlock[]): void {
  const count = (type: BookBlockType): number =>
    blocks.filter((block) => block.type === type).length;

  if (count("body") !== 1) {
    throw new Error(
      `blocks には本文（body）の面をちょうど1つ書いてください（いまは${count(
        "body"
      )}つです）。`
    );
  }
  for (const type of BOOK_SINGLE_BLOCK_TYPES) {
    if (count(type) > 1) {
      throw new Error(
        `blocks の${BOOK_BLOCK_LABELS[type]}（${type}）が${count(
          type
        )}つあります。この面は1冊に1つだけです。`
      );
    }
  }
}

/**
 * 登場人物一覧の指定（設計書6.65.11）。
 *
 * **書かれている側だけを差し替える。** 作者が `enabled` だけを手で書いた
 * ときに、イラストの有無まで既定へ戻っては困る（合成指定と同じ扱い）。
 */
function parseCharacterPage(
  raw: unknown,
  defaults: BookCharacterPage
): BookCharacterPage {
  if (raw === undefined || raw === null) return { ...defaults };
  const value = objectValue(raw, "characterPage");

  optionalBoolean(value.enabled, "characterPage.enabled");
  optionalBoolean(value.showIcons, "characterPage.showIcons");

  return {
    enabled: (value.enabled as boolean | undefined) ?? defaults.enabled,
    showIcons: (value.showIcons as boolean | undefined) ?? defaults.showIcons,
  };
}

/** 同梱する書体（設計書6.65.11）。表紙と同じ検証に、拡張子の確認を足す */
function parseFonts(raw: unknown): BookFonts {
  if (raw === undefined || raw === null) return { body: null, heading: null };
  const value = objectValue(raw, "fonts");

  optionalNullableString(value.body, "fonts.body");
  optionalNullableString(value.heading, "fonts.heading");

  return {
    body: fontPath(value.body, "本文用の書体"),
    heading: fontPath(value.heading, "見出し用の書体"),
  };
}

/**
 * 書体の場所。**表紙とまったく同じ「外を指せない」検証**を通し、
 * さらに扱える種類かを見る。
 *
 * 種類をここで断るのは、書き出しの途中で落ちると**書体1つのために本
 * そのものが出ない**からである（表紙画像と同じ考え方）。
 */
function fontPath(raw: unknown, label: string): string | null {
  const value = ((raw as string | null | undefined) ?? "").trim();
  if (!value) return null;

  const normalized = relativeInsideWork(value, label);
  const matched = /\.([A-Za-z0-9]+)$/.exec(normalized);
  const extension = matched ? matched[1].toLowerCase() : "";
  if (!BOOK_FONT_EXTENSIONS.includes(extension)) {
    throw new Error(
      `${label}「${value}」は本に入れられません。` +
        `${BOOK_FONT_EXTENSIONS.map((item) => `.${item}`).join(
          "・"
        )} のファイルを指定してください。`
    );
  }
  return normalized;
}

/**
 * 挿絵の指定を読む（設計書6.65.10）。
 *
 * **話が実在するかはここでは見ない。** `models` はファイルの一覧を持たない
 * ので、原稿が消えている・改題されたことに気づけるのは書き出しと画面である。
 * ここで確かめるのは「受け取ってよい形か」だけにする。
 */
function parseIllustrations(raw: unknown): BookIllustration[] {
  return (
    optionalObjectArray(raw, "illustrations", (entry, entryPath) => {
      optionalString(entry.caption, `${entryPath}.caption`);
      // 絵の無い挿絵は作らない。場所が空のまま保存されると、書き出しの
      // たびに「読めません」と言い続けることになる
      requireNonEmptyString(entry.imagePath, `${entryPath}.imagePath`);
      return {
        ...bodyPosition(entry, entryPath),
        imagePath: relativeInsideWork(
          (entry.imagePath as string).trim(),
          "挿絵"
        ),
        caption: ((entry.caption as string | undefined) ?? "").trim(),
      };
    }) ?? []
  );
}

/** ページ分割の指定。**挿絵とまったく同じ位置の検証を通す** */
function parsePageBreaks(raw: unknown): BookPageBreak[] {
  return (
    optionalObjectArray(raw, "pageBreaks", (entry, entryPath) =>
      bodyPosition(entry, entryPath)
    ) ?? []
  );
}

/** 「第N話の第M段落のあと」の共通部分。片方だけ緩くしない */
function bodyPosition(
  entry: Record<string, unknown>,
  entryPath: string
): BookBodyPosition {
  requireNonEmptyString(entry.episodePath, `${entryPath}.episodePath`);
  return {
    // **区切りは `/` に揃える。** Windowsで書かれた `本文\第1話.txt` と
    // 走査結果を突き合わせられないと、指定した挿絵が黙って出なくなる
    episodePath: (entry.episodePath as string).trim().replace(/\\/g, "/"),
    afterParagraph: paragraphNumber(
      entry.afterParagraph,
      `${entryPath}.afterParagraph`
    ),
  };
}

/**
 * 「第M段落のあと」の M。**1以上の整数だけ**を受け取る。
 *
 * 0や小数を通すと位置が黙ってずれる（例外にならないぶん見つけにくい）。
 * 話数の検証（`optionalNullableNumber`）と同じ考え方だが、こちらは
 * 省略も0も許さない——「第0段落のあと」に置き場所は無い。
 */
function paragraphNumber(raw: unknown, path: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1) invalid(path);
  return raw as number;
}

/**
 * 合成指定を読む。**書かれている要素だけを差し替える。**
 *
 * 作者が `title` の色だけを手で書いたときに、残りの3要素が消えては
 * 困る。ほかの台帳と同じで、**知らない値は既定へ倒さず例外にする**
 * ——倒すと「指定したのに効かない」ことに気づけない。
 */
function parseCoverLayout(
  raw: unknown,
  name: string,
  defaults: CoverLayout
): CoverLayout {
  if (raw === undefined || raw === null) return defaults;
  const value = objectValue(raw, name);
  // 色以外の型（数値など）を通すと `coverColor` の `.trim()` が落ちる
  // （文字要素の色と同じ検証を先に通す）
  optionalString(value.frameBackground, `${name}.frameBackground`);

  return {
    title: parseCoverText(value.title, `${name}.title`, defaults.title),
    author: parseCoverText(value.author, `${name}.author`, defaults.author),
    illustrator: parseCoverText(
      value.illustrator,
      `${name}.illustrator`,
      defaults.illustrator
    ),
    label: parseCoverText(value.label, `${name}.label`, defaults.label),
    // 枠の余白の色（設計書6.65.15）。文字要素と同じ16進の検証を通す
    frameBackground: coverColor(
      value.frameBackground as string | undefined,
      `${name}.frameBackground`,
      defaults.frameBackground
    ),
  };
}

function parseCoverText(
  raw: unknown,
  name: string,
  defaults: CoverTextStyle
): CoverTextStyle {
  if (raw === undefined || raw === null) return { ...defaults };
  const value = objectValue(raw, name);

  optionalBoolean(value.visible, `${name}.visible`);
  optionalEnum(value.anchor, `${name}.anchor`, COVER_ANCHORS);
  optionalEnum(value.size, `${name}.size`, COVER_TEXT_SIZES);
  optionalString(value.color, `${name}.color`);
  optionalBoolean(value.vertical, `${name}.vertical`);

  return {
    visible: (value.visible as boolean | undefined) ?? defaults.visible,
    anchor: (value.anchor as CoverAnchor | undefined) ?? defaults.anchor,
    size: (value.size as CoverTextSize | undefined) ?? defaults.size,
    color: coverColor(value.color as string | undefined, name, defaults.color),
    vertical: (value.vertical as boolean | undefined) ?? defaults.vertical,
  };
}

/**
 * 文字の色。**16進だけを受け取る。**
 *
 * `white` のような色名やCSSの関数を通すと、canvasの `fillStyle` が黙って
 * 解釈できないものを受け取って**黒で描く**（例外にならない）。焼いてから
 * 「なぜか黒い」と気づくより、書いた時点で断るほうが早い。
 */
function coverColor(
  raw: string | undefined,
  name: string,
  fallback: string
): string {
  const value = (raw ?? "").trim();
  if (!value) return fallback;
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
    throw new Error(
      `${name}.color の色「${value}」を読み取れません。#ffffff のような16進で書いてください。`
    );
  }
  return value.toLowerCase();
}

/**
 * 表紙・裏表紙の場所を確かめる。
 *
 * **作品フォルダの外は指せない。** 「相対パス」と決めてあるところへ
 * 絶対パスや `..` を書かれると、作品と関係のないファイルを本へ詰めて
 * 配ることになる。ここは `models` なので場所の解決はできないが、
 * **形の上で外を向いているもの**は受け取らずに済む。
 *
 * 表紙と裏表紙で**同じ関数を通す**。片方だけ緩いと、そちらが抜け道になる。
 */
function coverPath(raw: unknown, label: string): string | null {
  const value = ((raw as string | null | undefined) ?? "").trim();
  if (!value) return null;
  return relativeInsideWork(value, label);
}

/**
 * 作品フォルダの中を指す相対パスとして読む。
 *
 * 表紙・裏表紙・挿絵の**3か所とも同じ関数を通す**。片方だけ緩いと、
 * そちらが抜け道になる（裏表紙を足したときに決めた約束を、挿絵でも守る）。
 */
function relativeInsideWork(value: string, label: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(
      `${label}の場所「${value}」は作品フォルダからの相対パスで書いてください（絶対パスは使えません）。`
    );
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(
      `${label}の場所「${value}」が作品フォルダの外を指しています。`
    );
  }
  return normalized;
}
