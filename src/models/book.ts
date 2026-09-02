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
 * 第3段の前半で表紙・裏表紙の合成指定（6.65.8）を足した。挿絵・書体は
 * 第3段の後半でここへ足す。
 */

import {
  objectValue,
  optionalBoolean,
  optionalEnum,
  optionalNullableString,
  optionalString,
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

/** 1枚の表紙ぶんの合成指定 */
export type CoverLayout = Record<CoverElementKey, CoverTextStyle>;

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
   * **`nav.xhtml` そのものは EPUB3 で必須**なので、false でも作る。
   * ここが決めるのは「読む順路（spine）へ並べるか」だけである。
   */
  tocEnabled: boolean;
  /** 目次ページの並べ方。`tocEnabled` が false なら見た目に影響しない */
  tocPattern: TocPattern;
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
}

export const BOOK_SCHEMA_VERSION = "0.1";
/** `設定/` の下のフォルダ名 */
export const BOOK_DIR = "書籍";
export const BOOK_FILE = "book.json";

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
  };
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
    tocOrnament: "none",
    colophonOrnament: "none",
    collapseBlankLines: true,
    coverImagePath: null,
    backCoverImagePath: null,
    coverLayout: defaultCoverLayout(),
    backCoverLayout: defaultBackCoverLayout(),
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

  optionalString(value.title, "title");
  optionalString(value.author, "author");
  optionalString(value.illustrator, "illustrator");
  optionalString(value.label, "label");
  optionalEnum(value.writingMode, "writingMode", BOOK_WRITING_MODES);
  optionalBoolean(value.tocEnabled, "tocEnabled");
  optionalEnum(value.tocPattern, "tocPattern", TOC_PATTERNS);
  optionalEnum(value.tocOrnament, "tocOrnament", BOOK_ORNAMENTS);
  optionalEnum(value.colophonOrnament, "colophonOrnament", BOOK_ORNAMENTS);
  optionalBoolean(value.collapseBlankLines, "collapseBlankLines");
  optionalNullableString(value.coverImagePath, "coverImagePath");
  optionalNullableString(value.backCoverImagePath, "backCoverImagePath");

  const title = ((value.title as string | undefined) ?? "").trim();

  return {
    schemaVersion:
      typeof value.schemaVersion === "string"
        ? value.schemaVersion
        : BOOK_SCHEMA_VERSION,
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
  };
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

  return {
    title: parseCoverText(value.title, `${name}.title`, defaults.title),
    author: parseCoverText(value.author, `${name}.author`, defaults.author),
    illustrator: parseCoverText(
      value.illustrator,
      `${name}.illustrator`,
      defaults.illustrator
    ),
    label: parseCoverText(value.label, `${name}.label`, defaults.label),
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
