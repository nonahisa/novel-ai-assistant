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
 * VS Code API に依存しない（`models` の約束）。第1段（6.65.4）で使う項目
 * だけを持つ。表紙の合成・挿絵・書体は第3段でここへ足す。
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
}

export const BOOK_SCHEMA_VERSION = "0.1";
/** `設定/` の下のフォルダ名 */
export const BOOK_DIR = "書籍";
export const BOOK_FILE = "book.json";

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
    coverImagePath: coverPath(value.coverImagePath),
  };
}

/**
 * 表紙の場所を確かめる。
 *
 * **作品フォルダの外は指せない。** 「相対パス」と決めてあるところへ
 * 絶対パスや `..` を書かれると、作品と関係のないファイルを本へ詰めて
 * 配ることになる。ここは `models` なので場所の解決はできないが、
 * **形の上で外を向いているもの**は受け取らずに済む。
 */
function coverPath(raw: unknown): string | null {
  const value = ((raw as string | null | undefined) ?? "").trim();
  if (!value) return null;

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(
      `表紙の場所「${value}」は作品フォルダからの相対パスで書いてください（絶対パスは使えません）。`
    );
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(
      `表紙の場所「${value}」が作品フォルダの外を指しています。`
    );
  }
  return normalized;
}
