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
 * 目次ページの**並べ方**（設計書6.65.6）。
 *
 * - `list`：一覧。既定
 * - `chapters`：章ごとに区切り、章の見出しを立てる
 *
 * **向きはここが持たない**（作者の指摘、2026-09-13「目次のダブりも解消
 * されてないです」）。かつては `vertical`／`horizontal`／`chapters` の
 * 3択で、前の2つは**並べ方が同じで向きだけが違った**。面ごとの「文字の
 * 向き」の欄ができたことで、目次だけ向きの出どころが2つになったので、
 * ここからは向きの意味を外してある。目次の向きは、ほかの4面と同じ
 * `pageLayouts.toc.vertical` だけが決める。
 *
 * 古い値は読み込みで読み替える（`migrateTocPattern`）。
 */
export type TocPattern = "list" | "chapters";

export const TOC_PATTERNS: readonly TocPattern[] = ["list", "chapters"];

/**
 * 0.55.x までの `tocPattern`。**読み込みでだけ受け取る。**
 *
 * 弾いてしまうと、いままで書き出せていた本の設計図が版を上げただけで
 * 開けなくなる（作者は本を直す入口にもたどり着けない）。
 */
const LEGACY_TOC_PATTERNS = ["vertical", "horizontal"] as const;

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
 * 飾りの id（設計書6.65.17）。**決まった3つではなく、ただの文字列である。**
 *
 * 飾りは組み込みの8種のほかに、`設定/書籍/飾り/*.svg` と共通フォルダーから
 * 増やせる（図録は `core/epubOrnaments.ts`）。`models` は `core` に依存
 * できないので、**ここでは形（文字列）だけを決め、実在するかは見ない**。
 *
 * **知らない id を読みで落とさない。** 共通フォルダーを外した端末で
 * book.json を開いただけで、作者が選んだ飾りが黙って「なし」に書き換わって
 * しまう。描くときに図録を引いて、無ければ「なし」と同じ扱いにする
 * （`buildOrnamentFragment`）——**値は消さない**、というほかの台帳と
 * 同じ約束である。
 */
export type BookOrnamentId = string;

/**
 * 飾りを置く場所（設計書6.65.17）。中表紙の題名の上／下／上下。
 *
 * **既定は「下」。** 題名の下に飾りを敷くのが日本語の本でいちばん多く、
 * 上だけに置くと、扉を開いた最初の行が飾りになって題名が下がる。
 */
export type BookOrnamentPlace = "above" | "below" | "both";

export const BOOK_ORNAMENT_PLACES: readonly BookOrnamentPlace[] = [
  "above",
  "below",
  "both",
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
  /**
   * 人物イラストを添えるか。読めない人物は名前だけ。
   *
   * 絵の在りかは台帳の `icon` 欄と、`素材/` の中の名前が同じ画像から引く
   * （`core/characterIconLookup.ts`）。
   */
  showIcons: boolean;
  /**
   * 名前のルビ（作者の指定、2026-09-13「人物紹介もルビは選べるように
   * したほうが良いかも」）。
   *
   * **省略＝`all`**（すべてに付ける）。いままでの本と同じ見た目なので、
   * ここを書いていない book.json の本は1文字も変わらない。既定のときは
   * 保存でも書き足さない（`pageLayouts` と同じ約束）。
   */
  rubyMode?: CharacterRubyMode;
}

/**
 * 人物紹介の名前へルビを振る範囲（作者の指定、2026-09-13）。
 *
 * 読み仮名があれば必ずルビが付いていたため、実機では「イント→いんと」
 * 「ターナ先生→たーなせんせい」のような、読みの助けにならないルビが
 * 並んでいた。仮名だけの名前に仮名を振っても読者は何も得ない。
 *
 * - `all`：すべてに付ける（**既定**。いままでと同じ）
 * - `kanjiOnly`：漢字を含む名前だけに付ける
 * - `none`：付けない
 */
export type CharacterRubyMode = "all" | "kanjiOnly" | "none";

export const CHARACTER_RUBY_MODES: readonly CharacterRubyMode[] = [
  "all",
  "kanjiOnly",
  "none",
];

/** 何も選んでいない本の振る舞い。**既存の本の見た目を変えない** */
export const DEFAULT_CHARACTER_RUBY_MODE: CharacterRubyMode = "all";

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

/**
 * 面の中の文字の体裁（作者の依頼、2026-09-13
 * 「本文以外の表紙等の文字について、縦書き横書き、上寄せ下寄せ、右寄せ左寄せ、
 * 等選べるようにしてください」）。
 *
 * 表紙・裏表紙は canvas へ焼く合成なので別の仕組み（`CoverTextStyle`）が
 * 持っている。ここは**それ以外の面**——中表紙・目次・人物紹介・あとがき・
 * 奥付——のためのものである。
 *
 * ## 寄せは論理の方向で持つ（`top`／`left` ではない）
 *
 * 縦書きと横書きで「上下」と「左右」の意味が入れ替わるので、`top` のような
 * 名前で持つと、向きを変えたとたんに指定の意味が変わる。ここは CSS の論理
 * プロパティと同じ `start`／`center`／`end` で持ち、**画面に出す言葉だけを
 * 向きに合わせて出し分ける**（`pageAlignLabels`）。
 *
 * ## 省略が既定である
 *
 * どの項目も省略できる。省略＝**いままでどおり**（本の綴じ方向に従い、
 * 寄せの指定も出さない）で、何も選んでいない面の見た目は1ピクセルも
 * 変わらない。`suspended` と同じ約束で、選んでいない面には項目そのものを
 * 書かない——`false` や `"start"` を書き足すと、いままでの book.json が
 * 保存のたびに既定値だらけになってGitの差分が読めなくなる。
 */
export type PageTextAlign = "start" | "center" | "end";

export const PAGE_TEXT_ALIGNS: readonly PageTextAlign[] = [
  "start",
  "center",
  "end",
];

export interface PageTextLayout {
  /** 縦書きか。省略時は本の綴じ方向に従う（いまの見た目を変えない） */
  vertical?: boolean;
  /** 上下の寄せ（横書きのとき）。縦書きでは左右の寄せになる */
  block?: PageTextAlign;
  /** 左右の寄せ（横書きのとき）。縦書きでは上下の寄せになる */
  inline?: PageTextAlign;
}

/**
 * 体裁を選べる面。**面の種類を鍵にした1つの表**で持つ（設計書6.65.15）。
 *
 * 面ごとに別々の欄を5つ作ると、面が増えるたびに台帳・画面・CSSの3か所へ
 * 同じ形の項目を足すことになる。
 *
 * 表紙・裏表紙（`cover`・`backCover`）はここに無い——本へ入るのは合成して
 * 焼いた画像1枚なので、XHTML の体裁という概念が無い。本文（`body`）も
 * 無い：本文の組み方は本そのものの綴じ方向である。口絵・扉絵は画像1枚で、
 * 文字を持たない。
 */
export const PAGE_LAYOUT_BLOCK_TYPES = [
  "halfTitle",
  "toc",
  "characters",
  "afterword",
  "colophon",
] as const;

export type PageLayoutBlockType = (typeof PAGE_LAYOUT_BLOCK_TYPES)[number];

export type BookPageLayouts = Partial<
  Record<PageLayoutBlockType, PageTextLayout>
>;

/**
 * 向きが**面ぜんぶには効かない**面。目次だけである。
 *
 * **向きは5面とも選べる**（作者の指摘、2026-09-13）。ただし目次の向きが
 * 変えるのは中の一覧（`<ol class="toc-horizontal">`）だけで、面そのもの
 * （`<nav>`）は本の綴じ方向のままにしてある——ここを面ぜんぶへ広げると、
 * 「目次だけ横組み」を選んでいた**既にある本の見た目が変わる**。
 *
 * この表を見るのは2か所。CSSに面ぜんぶの `writing-mode` を出すかどうか
 * （`pageLayoutForCss`）と、寄せの呼び名を縦横どちらで出すか
 * （`pageLayoutVertical`）である。寄せが効くのは面そのものなので、
 * 呼び名も面の向き＝本の綴じ方向で出す。
 */
export const PAGE_LAYOUT_LIST_ONLY_ORIENTATION: readonly PageLayoutBlockType[] =
  ["toc"];

/** その面の向きが、面ぜんぶ（`writing-mode` と寄せの意味）に効くか */
export function pageOrientationAffectsWholePage(
  type: PageLayoutBlockType
): boolean {
  return !PAGE_LAYOUT_LIST_ONLY_ORIENTATION.includes(type);
}

/**
 * 目次の一覧の向き。**選んでいなければ undefined（本に従う）。**
 *
 * 書き出しとプレビューが同じ判断をするための1か所である（`epubPackage.ts`
 * の `buildTocFragment`）。`true`／`false` を返したときだけ、一覧に向きの
 * クラスを付ける——`undefined` のときは、いままでどおり何も足さない。
 */
export function tocListOrientation(
  layouts: BookPageLayouts | undefined
): boolean | undefined {
  return layouts?.toc?.vertical;
}

/**
 * 面ごとのCSSクラス。**XHTMLもCSSも画面も、必ずここから作る。**
 *
 * 書き出しの断片（`core/epubPackage.ts`）とCSS（`buildEpubCss`）が別々に
 * 名前を組み立てると、片方を直した日から体裁が当たらなくなる。
 */
export function pageLayoutClass(type: PageLayoutBlockType): string {
  return `page-${type}`;
}

/**
 * その面に体裁が選ばれていれば、当てるためのクラス。**無ければ空文字。**
 *
 * **選んでいない面には、クラスも付けない。** 当てるCSSが無ければ見た目は
 * 変わらないが、いままで出ていた本のXHTMLが1バイトも変わらないほうが
 * 確かめやすい（`exportEpubCollected.test.ts` は本の中身をハッシュで
 * 固定している）。
 */
export function pageLayoutClassFor(
  type: PageLayoutBlockType,
  layouts: BookPageLayouts | undefined
): string {
  return pageLayoutForCss(type, layouts) ? pageLayoutClass(type) : "";
}

/**
 * その面のCSSに出す体裁。**出すものが無ければ undefined。**
 *
 * 目次だけは**向きを落とす**——目次の向きが変えるのは中の一覧だけで、
 * 面ぜんぶの `writing-mode` にはしない（`PAGE_LAYOUT_LIST_ONLY_ORIENTATION`
 * の説明を参照）。向きしか選んでいない目次は、ここで undefined になるので
 * クラスも規則も出ない——「目次だけ横組み」を選んでいた既にある本の
 * XHTMLもCSSも1バイトも変わらない。
 */
export function pageLayoutForCss(
  type: PageLayoutBlockType,
  layouts: BookPageLayouts | undefined
): PageTextLayout | undefined {
  const layout = layouts?.[type];
  if (!layout) return undefined;
  if (pageOrientationAffectsWholePage(type)) return layout;

  const rest: PageTextLayout = {};
  if (layout.block) rest.block = layout.block;
  if (layout.inline) rest.inline = layout.inline;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** クラスを `class="…"` の中へ足すときの書き方（前の空白を忘れない） */
export function pageLayoutClassSuffix(
  type: PageLayoutBlockType,
  layouts: BookPageLayouts | undefined
): string {
  const name = pageLayoutClassFor(type, layouts);
  return name ? ` ${name}` : "";
}

/** 寄せの軸。`block` が行の進む向き、`inline` が字の進む向き */
export type PageTextAxis = "block" | "inline";

export interface PageAlignChoice {
  value: PageTextAlign;
  label: string;
}

export interface PageAlignLabels {
  /** 欄の見出し（「上下の寄せ」「左右の寄せ」） */
  axis: string;
  options: readonly PageAlignChoice[];
}

/** 何も選んでいないときの選択肢の呼び名（いままでどおりの見た目） */
export const PAGE_ALIGN_UNSET_LABEL = "既定のまま";

/** 縦横を選ぶ欄の選択肢。**空文字が「本に従う」**（省略＝既定） */
export const PAGE_ORIENTATION_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "", label: "本に従う" },
  { value: "vertical", label: "縦書き" },
  { value: "horizontal", label: "横書き" },
];

/** 上から下（横書きの行送り／縦書きの字の進む向き） */
const ALIGN_TOP_BOTTOM: PageAlignLabels = {
  axis: "上下の寄せ",
  options: [
    { value: "start", label: "上寄せ" },
    { value: "center", label: "中央" },
    { value: "end", label: "下寄せ" },
  ],
};

/** 左から右（横書きの字の進む向き） */
const ALIGN_LEFT_RIGHT: PageAlignLabels = {
  axis: "左右の寄せ",
  options: [
    { value: "start", label: "左寄せ" },
    { value: "center", label: "中央" },
    { value: "end", label: "右寄せ" },
  ],
};

/** 右から左（縦書きの行送り）。**`start` が「右寄せ」になる** */
const ALIGN_RIGHT_LEFT: PageAlignLabels = {
  axis: "左右の寄せ",
  options: [
    { value: "start", label: "右寄せ" },
    { value: "center", label: "中央" },
    { value: "end", label: "左寄せ" },
  ],
};

/**
 * 画面に出す寄せの呼び名（作者の依頼、2026-09-13）。
 *
 * **縦書きでは上下と左右の意味が入れ替わる。** 縦組みの面で `block: "start"`
 * は「右寄せ」であり、ここを間違えると作者は毎回逆を選ぶことになる。
 * 呼び名を1か所に置いて、画面はここから受け取るだけにする。
 */
export function pageAlignLabels(
  axis: PageTextAxis,
  vertical: boolean
): PageAlignLabels {
  if (axis === "block") {
    // 行の進む向き。横書きは上→下、縦書きは右→左
    return vertical ? ALIGN_RIGHT_LEFT : ALIGN_TOP_BOTTOM;
  }
  // 字の進む向き。横書きは左→右、縦書きは上→下
  return vertical ? ALIGN_TOP_BOTTOM : ALIGN_LEFT_RIGHT;
}

/**
 * その面が縦書きになるか（画面の呼び名と、寄せの意味を決める）。
 *
 * **目次の面は本の綴じ方向に従う。** 目次で選んだ向きが変えるのは中の
 * 一覧（`<ol>`）だけで、面そのもの（`<nav>`）の向きは本のままである
 * ——寄せが効くのは面そのものなので、呼び名も面の向きで出す。
 */
export function pageLayoutVertical(
  type: PageLayoutBlockType,
  layouts: BookPageLayouts | undefined,
  bookVertical: boolean
): boolean {
  if (!pageOrientationAffectsWholePage(type)) return bookVertical;
  return layouts?.[type]?.vertical ?? bookVertical;
}

/**
 * どの面にも付く印（設計書6.65.15の段D。作者の依頼、2026-09-04）。
 *
 * **保留は「消さずに本から外す」印である。** あとがきや口絵を、消さずに
 * 今回の本からだけ外せるようにする。
 *
 * **1冊に1つの面を2枚置くための印ではない**（0.32.0のレビューで戻した）。
 * 表紙などの中身は `BookConfig` に1つしかないので、2枚置いても同じ面が
 * 並ぶだけである（`canAddBookBlock`）。
 *
 * **省略＝有効。** 保留でない面には項目そのものを書かない——`false` を
 * 書き足すと、いままでの book.json が保存のたびに `suspended: false`
 * だらけになり、Gitの差分が読めなくなる。
 */
export interface BookBlockSuspension {
  /** 保留中か。省略＝有効（本に入る） */
  suspended?: boolean;
}

/** 画像の面（口絵・扉絵）。場所の検証は表紙・挿絵とまったく同じ */
export interface BookImageBlock extends BookBlockSuspension {
  type: BookImageBlockType;
  /** 作品フォルダからの相対パス */
  imagePath: string;
  /** 図版の下に添える文。空なら出さない（挿絵と同じ） */
  caption: string;
}

/** 画像以外の面。**種類のほかに持つものが無い**（設定は BookConfig 側） */
export interface BookPlainBlock extends BookBlockSuspension {
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
  /**
   * 目次ページの**並べ方**。`tocEnabled` が false なら見た目に影響しない。
   *
   * 向きはここが持たない（`pageLayouts.toc.vertical` が持つ）。
   */
  tocPattern: TocPattern;
  /** 目次の1行に出す見出しの形（設計書6.65.15）。既定は番号＋題 */
  tocEntryStyle: TocEntryStyle;
  /** 目次ページの飾り。図録の id（`core/epubOrnaments.ts`） */
  tocOrnament: BookOrnamentId;
  /** 奥付の飾り。目次とは別に選べる（片方だけ飾りたいことがある） */
  colophonOrnament: BookOrnamentId;
  /**
   * 中表紙（扉）の飾り（設計書6.65.17）。既定は「なし」。
   *
   * **表紙が画像1枚の本では、題名を文字で読める面はここだけ**である
   * （`buildTitlePageFragment` の説明を参照）。目次・奥付とは別に選べる。
   */
  titlePageOrnament: BookOrnamentId;
  /** 中表紙の飾りを題名の上・下・上下のどこに置くか。既定は「下」 */
  titlePageOrnamentPlace: BookOrnamentPlace;
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
  /**
   * 面ごとの文字の体裁（作者の依頼、2026-09-13）。**省略できる。**
   *
   * 書いていない面は、いままでとまったく同じ見た目で組まれる。選んで
   * いない面の項目は**書かない**ので、既にある book.json はこの版でも
   * 1文字も増えない（`PageTextLayout` の説明を参照）。
   */
  pageLayouts?: BookPageLayouts;
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

/** 保留中の面か（設計書6.65.15の段D）。**省略＝有効** */
export function isBookBlockSuspended(block: BookBlock): boolean {
  return block.suspended === true;
}

/**
 * 本に入る面だけ（設計書6.65.15の段D）。
 *
 * **書き出しとプレビューの組み立ては、必ずここを通す。** 保留の面は
 * 設計図には残るが、本の中には1面も出ない——「並びに書いてあるかで
 * 決める」という段Cの約束を、保留の印まで含めて1か所で持つ。
 */
export function activeBookBlocks(blocks: readonly BookBlock[]): BookBlock[] {
  return blocks.filter((block) => !isBookBlockSuspended(block));
}

/**
 * その種類を、いまの並びへもう1つ置けるか（設計書6.65.15の段C・段D）。
 *
 * 口絵・扉絵は何枚でも置ける。1冊に1つの面は、既にあれば置けない
 * （本文もここに入るので、複製そのものができない）。
 *
 * **数えるのは保留も含めた全ブロックである。** 段Dでは「有効な面だけ」と
 * して、表紙を保留にすればもう1案を挿せるようにしていたが、**面の中身は
 * `BookConfig` に1つしかないので、2枚あっても同じものが並ぶだけ**だった
 * （表紙・遊び紙・目次・人物紹介・奥付・裏表紙のいずれも、書誌情報や
 * 目次の体裁といった本に1つの設定欄から組む）。狙っていた「2案の見比べ」
 * にならないので、数え方を戻した。**面ごとに中身を持てるようになったら
 * （将来の段E）、有効のみ数える形へ緩める。**
 */
export function canAddBookBlock(
  blocks: readonly BookBlock[],
  type: BookBlockType
): boolean {
  if (!isSingleBookBlockType(type)) return true;
  return !blocks.some((block) => block.type === type);
}

/**
 * その位置の面を保留にできるか（設計書6.65.15の段D）。
 *
 * **本文だけは保留にできない。** 本文の無い本になるので、削除を断るのと
 * 同じ理由である（`canRemoveBookBlock` と判断を揃える）。
 */
export function canSuspendBookBlock(
  blocks: readonly BookBlock[],
  index: number
): boolean {
  const block = blocks[index];
  if (block === undefined || isBookBlockSuspended(block)) return false;
  return block.type !== "body";
}

/**
 * その位置の面の保留を解除できるか（設計書6.65.15の段D）。
 *
 * **同じ種類の有効な面が居れば解除できない。** 黙って2つ有効にすると、
 * どちらの設定が効いた本なのか作者に分からなくなる（保存のときに
 * `assertBlockCounts` が断る形と、ここでの断り方を揃える）。断る言葉は
 * 呼び出し側が出す——「押しても無反応」にはしない。
 *
 * **`canAddBookBlock` が保留も数えるようになっても、この判定は残す**
 * （0.32.0のレビュー）。画面からは「有効1＋保留1」を作れなくなったが、
 * book.json を手で書けばその形は作れる。読み込みは受け入れ（`assertBlockCounts`
 * は有効のみ数える）、**解除だけを断る**——作者が書いたものを消さずに、
 * 2つ有効になることだけを防ぐ守りである。
 */
export function canResumeBookBlock(
  blocks: readonly BookBlock[],
  index: number
): boolean {
  const block = blocks[index];
  if (block === undefined || !isBookBlockSuspended(block)) return false;
  if (!isSingleBookBlockType(block.type)) return true;
  return !blocks.some(
    (entry, position) =>
      position !== index &&
      entry.type === block.type &&
      !isBookBlockSuspended(entry)
  );
}

/**
 * 面の保留を切り替える（設計書6.65.15の段D）。**できないときは null。**
 *
 * 解除したら `suspended` を**項目ごと消す**。`false` を残すと、保留を
 * 一度も使っていない本と使ってやめた本で book.json の形が変わってしまう
 * （省略＝有効、という読み方を1つに保つ）。
 */
export function setBookBlockSuspended(
  blocks: readonly BookBlock[],
  index: number,
  suspended: boolean
): BookBlock[] | null {
  const allowed = suspended
    ? canSuspendBookBlock(blocks, index)
    : canResumeBookBlock(blocks, index);
  if (!allowed) return null;

  return blocks.map((block, position) => {
    if (position !== index) return block;
    if (suspended) return { ...block, suspended: true };
    const resumed = { ...block };
    delete resumed.suspended;
    return resumed;
  });
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
    // 同じものが出ないと、版を上げただけで本の体裁が変わる（旧 `vertical`
    // ＝「本文と同じ流れの一覧」と同じもの。向きは選ばない＝本に従う）
    tocPattern: "list",
    // **既定は「番号＋題」**（いままでどおりの見た目。重複除去のあとの形）
    tocEntryStyle: "numberAndTitle",
    tocOrnament: "none",
    colophonOrnament: "none",
    // 中表紙の飾りも既定は無し（既にある本の見た目を1文字も変えない）
    titlePageOrnament: "none",
    titlePageOrnamentPlace: "below",
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
  // **古い綴りも受け取る**（`LEGACY_TOC_PATTERNS`）。読み替えは下の
  // `migrateTocPattern` が行う——知らない綴りは、いままでどおり断る
  optionalEnum(value.tocPattern, "tocPattern", [
    ...TOC_PATTERNS,
    ...LEGACY_TOC_PATTERNS,
  ]);
  optionalEnum(value.tocEntryStyle, "tocEntryStyle", TOC_ENTRY_STYLES);
  // **飾りの id は文字列として受け取る**（設計書6.65.17）。図録に無い id を
  // ここで弾くと、共通フォルダーを外した端末で設計図そのものが読めなくなる
  optionalString(value.tocOrnament, "tocOrnament");
  optionalString(value.colophonOrnament, "colophonOrnament");
  optionalString(value.titlePageOrnament, "titlePageOrnament");
  // 置き場所は3つしかないので、いままでどおり知らない値を弾く
  optionalEnum(
    value.titlePageOrnamentPlace,
    "titlePageOrnamentPlace",
    BOOK_ORNAMENT_PLACES
  );
  optionalBoolean(value.collapseBlankLines, "collapseBlankLines");
  optionalNullableString(value.coverImagePath, "coverImagePath");
  optionalNullableString(value.backCoverImagePath, "backCoverImagePath");

  const title = ((value.title as string | undefined) ?? "").trim();
  // 並べ方と向きは、古い設計図の読み替えで**一緒に決まる**（下の説明を参照）
  const toc = migrateTocPattern(
    value.tocPattern,
    parsePageLayouts(value.pageLayouts),
    defaults.tocPattern
  );

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
    tocPattern: toc.pattern,
    tocEntryStyle:
      (value.tocEntryStyle as TocEntryStyle | undefined) ??
      defaults.tocEntryStyle,
    tocOrnament: ornamentId(value.tocOrnament, defaults.tocOrnament),
    colophonOrnament: ornamentId(
      value.colophonOrnament,
      defaults.colophonOrnament
    ),
    titlePageOrnament: ornamentId(
      value.titlePageOrnament,
      defaults.titlePageOrnament
    ),
    titlePageOrnamentPlace:
      (value.titlePageOrnamentPlace as BookOrnamentPlace | undefined) ??
      defaults.titlePageOrnamentPlace,
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
    // 面ごとの体裁（作者の依頼、2026-09-13）。**何も選んでいなければ
    // 項目ごと持たない**——book.json にも出ないので、いままでの本の
    // ファイルは1文字も変わらない
    pageLayouts: toc.pageLayouts,
  };
}

/**
 * 古い `tocPattern` を、いまの「並べ方」と「文字の向き」へ読み替える
 * （作者の指摘、2026-09-13「目次のダブりも解消されてないです」）。
 *
 * | 古い値 | 並べ方 | 向き |
 * |---|---|---|
 * | `vertical` | `list` | 触らない（本に従う） |
 * | `horizontal` | `list` | 未設定のときだけ横書き |
 * | `chapters` | `chapters` | 触らない |
 *
 * **作者が既に向きを選んでいたら、そちらを勝たせる。** 読み替えは古い
 * 設計図を今の形で読むためのものであって、作者の選択を上書きする権限は
 * 無い（「作者が書いたデータを上書きしない」と同じ約束）。
 *
 * **`vertical` で向きを入れないのは、それが「本に従う」だったから**である
 * ——横組みの本で目次だけ縦になっては、作者が何も選んでいないのに見た目が
 * 変わる（0.29.18で決めたとおり）。
 *
 * ここで読み替えてもファイルは書き換わらない。保存して初めて新しい綴りで
 * book.json に入る（`blocks` の補いと同じ）。
 */
function migrateTocPattern(
  raw: unknown,
  layouts: BookPageLayouts | undefined,
  fallback: TocPattern
): { pattern: TocPattern; pageLayouts: BookPageLayouts | undefined } {
  if (raw === "chapters") return { pattern: "chapters", pageLayouts: layouts };
  if (raw === "vertical") return { pattern: "list", pageLayouts: layouts };
  if (raw === "horizontal") {
    // 既に選ばれていれば触らない（作者の選択が勝つ）
    if (layouts?.toc?.vertical !== undefined) {
      return { pattern: "list", pageLayouts: layouts };
    }
    return {
      pattern: "list",
      pageLayouts: {
        ...layouts,
        toc: { ...layouts?.toc, vertical: false },
      },
    };
  }
  return {
    pattern: (raw as TocPattern | undefined) ?? fallback,
    pageLayouts: layouts,
  };
}

/**
 * 面ごとの文字の体裁を読む（作者の依頼、2026-09-13）。
 *
 * **知らない値は落とす。** ほかの項目（飾りの置き場所・面の種類）は例外に
 * しているが、ここだけは扱いを変えてある——体裁は**無くても本は組める**
 * 飾りの指定であり、綴じ方向や面の並びのように本の骨格を決めるものでは
 * ない。1つの綴りの間違いで設計図そのものが開けなくなると、作者は本を
 * 直す入口（エディター画面）にもたどり着けない。
 *
 * 落とすのは**読めなかった軸だけ**で、同じ面のほかの軸は残す。面ごと
 * 捨てると、`block` の綴りを間違えただけで `inline` の指定まで消える。
 *
 * 空（どの面も何も選んでいない）なら undefined を返す。`{}` を返すと
 * book.json に空の `pageLayouts` が書かれ、何も選んでいない本のファイルが
 * 保存のたびに増えてしまう。
 */
function parsePageLayouts(raw: unknown): BookPageLayouts | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = objectValue(raw, "pageLayouts");

  const out: BookPageLayouts = {};
  for (const type of PAGE_LAYOUT_BLOCK_TYPES) {
    const entry = value[type];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const layout: PageTextLayout = {};

    // **目次の向きもここが受け取る**（作者の指摘、2026-09-13）。向きの
    // 出どころは5面とも1つだけ——目次で効く範囲だけが違う
    // （`PAGE_LAYOUT_LIST_ONLY_ORIENTATION`）
    if (typeof record.vertical === "boolean") layout.vertical = record.vertical;
    const block = pageAlignValue(record.block);
    if (block) layout.block = block;
    const inline = pageAlignValue(record.inline);
    if (inline) layout.inline = inline;

    if (Object.keys(layout).length > 0) out[type] = layout;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** 寄せの値。知らない綴りは「選んでいない」と同じに扱う（上の説明を参照） */
function pageAlignValue(raw: unknown): PageTextAlign | undefined {
  return typeof raw === "string" &&
    (PAGE_TEXT_ALIGNS as readonly string[]).includes(raw)
    ? (raw as PageTextAlign)
    : undefined;
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

    // 保留の印（設計書6.65.15の段D）。**省略＝有効**なので、書いていない
    // 面には項目を足さずに返す（`false` を書き足すと、いままでの
    // book.json が保存のたびに `suspended: false` だらけになる）
    optionalBoolean(entry.suspended, `${entryPath}.suspended`);
    const suspension =
      entry.suspended === true ? ({ suspended: true } as const) : {};

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
        ...suspension,
      };
    }

    return { type: type as BookPlainBlock["type"], ...suspension };
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
 *
 * **数えるのは有効な面だけである**（設計書6.65.15の段D）。保留の面は本に
 * 1面も入らないので、表紙を2案書いて片方を保留にした設計図は**読める**。
 * 画面からはもう作れない形（`canAddBookBlock` が保留も数える）だが、
 * **手で書いた設計図を読めなくしない**——作者が書いたものを、こちらの
 * 都合で「壊れている」と言わないための受け皿である（解除だけは
 * `canResumeBookBlock` が断る）。ただし**本文の保留は断る**：本文の無い
 * 本になり、削除を断っている意味が無くなる。
 */
function assertBlockCounts(blocks: readonly BookBlock[]): void {
  const active = activeBookBlocks(blocks);
  const count = (type: BookBlockType): number =>
    active.filter((block) => block.type === type).length;

  if (blocks.some((block) => block.type === "body" && isBookBlockSuspended(block))) {
    throw new Error(
      "blocks の本文（body）は保留にできません（本文の無い本になります）。"
    );
  }
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
        )}つあります。この面は1冊に1つだけです` +
          "（片方を保留にすれば読み込めますが、本に入るのは1つだけです）。"
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

  const rubyMode =
    value.rubyMode === undefined
      ? defaults.rubyMode
      : parseCharacterRubyMode(value.rubyMode);

  return {
    enabled: (value.enabled as boolean | undefined) ?? defaults.enabled,
    showIcons: (value.showIcons as boolean | undefined) ?? defaults.showIcons,
    // **既定（すべてに付ける）は項目ごと持たない。** `{}` を書く体裁と
    // 同じ理由で、何も選んでいない本の book.json が保存のたびに太る
    ...(rubyMode && rubyMode !== DEFAULT_CHARACTER_RUBY_MODE
      ? { rubyMode }
      : {}),
  };
}

/**
 * ルビの選択（作者の指定、2026-09-13）。**知らない値は既定へ落とす。**
 *
 * 面ごとの体裁と同じ扱いにしてある——ルビの有無は飾りであって本の骨格
 * ではなく、綴りを1つ間違えただけで設計図が開けなくなると、作者は本を
 * 直す入口（エディター画面）にもたどり着けない。
 */
function parseCharacterRubyMode(raw: unknown): CharacterRubyMode | undefined {
  return typeof raw === "string" &&
    (CHARACTER_RUBY_MODES as readonly string[]).includes(raw)
    ? (raw as CharacterRubyMode)
    : undefined;
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
 * 飾りの id（設計書6.65.17）。**空白だけは「書いていない」と同じに扱う。**
 *
 * 図録に実在するかは見ない（`models` は図録を知らない）。知らない id は
 * そのまま持ち回り、描くときに「なし」へ倒す——作者が選んだ値を、
 * 読み込みのついでに消さないための扱いである。
 */
function ornamentId(raw: unknown, fallback: BookOrnamentId): BookOrnamentId {
  const value = ((raw as string | undefined) ?? "").trim();
  return value || fallback;
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
