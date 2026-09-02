import type { Character } from "../models/character";
import { escapeXml } from "./epubXhtml";

/**
 * 登場人物一覧の面（設計書6.65.11。第3段の後半）。
 *
 * ## 台帳をそのまま本へ流さない
 *
 * `設定/characters/` の中身は、**AIが本文から読み取ったものが混ざって
 * いる**。確かめていない記述や、先の話のネタバレがそのまま配布物へ入る
 * のは事故なので、載せる人物と項目の両方を絞る。
 *
 * - 人物：**登場済み・モブでない・いちばん公開寄り**（`spoilerLevel` が
 *   `public`）の3つを満たすものだけ
 * - 項目：**名前（読み仮名はルビ）と紹介文（`summary`）だけ**。役割・
 *   関係・外見まで並べると、本の中に設定資料集ができてしまう
 *
 * 並びは台帳の並びのまま（作者が台帳で決めた順を本でも守る）。
 *
 * ## 台帳へは一切書き込まない
 *
 * ここは読むだけである。本を作るために人物ファイルへ何かを書き足すことは
 * しない（原稿と同じ扱い）。
 *
 * ここは vscode に触らない（単体テストできる）。ZIPへ詰めるのは
 * `epubPackage.ts`、台帳を読むのは `features/exportEpub.ts` が行う。
 */

/**
 * 本へ載せてよいネタバレ区分。
 *
 * `Character.spoilerLevel` は `public`／`staff_only`／`author_only` の3つで、
 * **`public` がいちばん公開寄り**（`staff_only` は編集部まで、`author_only`
 * は作者だけ、と外へ出せる範囲が狭くなる）。読者へ配る本に載せられるのは
 * `public` だけである。
 */
export const BOOK_SPOILER_LEVEL: Character["spoilerLevel"] = "public";

/** 本へ載せる人物1人ぶん。**台帳の項目を全部は持たない** */
export interface EpubCharacterEntry {
  name: string;
  /** 読み仮名。あればルビになる。無ければ名前だけ */
  reading: string | null;
  /** 紹介文。空なら名前だけの人物になる */
  summary: string;
  /**
   * 人物イラストの在りか。**呼び出し側が決める**——本ではZIPの中の
   * 機械名（`portrait-1.png`）、画面では `asWebviewUri` のURIになる
   * （挿絵と同じ流儀）。読めない人物は null で、名前だけが載る。
   */
  iconHref: string | null;
}

/**
 * 本へ載せる人物を選ぶ（設計書6.65.11）。
 *
 * **並べ替えない。** 台帳の並びは作者が決めたものなので、本でも守る。
 */
export function selectBookCharacters(
  characters: readonly Character[]
): Character[] {
  return characters.filter(
    (character) =>
      character.status === "登場済み" &&
      !character.isMob &&
      character.spoilerLevel === BOOK_SPOILER_LEVEL
  );
}

/** 台帳の1件から、本へ入れる項目だけを取り出す（イラストは呼び出し側が付ける） */
export function toCharacterEntry(character: Character): EpubCharacterEntry {
  const reading = (character.reading ?? "").trim();
  return {
    name: character.name.trim(),
    // 空文字の読み仮名は「無い」と同じ。空の `<rt>` を作らない
    reading: reading || null,
    summary: (character.summary ?? "").trim(),
    iconHref: null,
  };
}

/**
 * 人物イラストの場所を、作品フォルダの中の相対パスとして読む。
 *
 * **外を指すものは受け取らない。** book.json の画像と違って `icon` は
 * 検証を通っていない自由記述なので、ここで確かめる必要がある。
 *
 * **例外にはしない。** 台帳の1件のせいで本が出ないより、その人物を
 * 名前だけにして本を出すほうがよい（挿絵と同じ流儀。入らなかったことは
 * 呼び出し側が通知に出す）。
 */
export function characterIconPath(icon: string | null): string | null {
  const value = (icon ?? "").trim();
  if (!value) return null;

  // 区切りは `/` に揃える。Windowsで書かれた `素材\月島.png` も読めるように
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

/**
 * 一覧の面の断片。**書き出しとプレビューが共に使う**（設計書6.65.6）。
 *
 * 1人ぶんは「イラスト（あれば）→名前→紹介文（あれば）」の順。
 * **無い項目は要素ごと出さない**——空の `<p>` は「紹介文が無い」ではなく
 * 「空の紹介文がある」という主張になる（奥付と同じ約束）。
 */
export function buildCharacterPageFragment(
  entries: readonly EpubCharacterEntry[]
): string {
  return [
    '<section class="characters">',
    '<h1 class="characters-heading">登場人物</h1>',
    ...entries.flatMap((entry) => characterFragment(entry)),
    "</section>",
  ].join("\n");
}

function characterFragment(entry: EpubCharacterEntry): string[] {
  const summary = entry.summary.trim();
  return [
    '<div class="character">',
    ...(entry.iconHref
      ? [
          '<div class="character-portrait">',
          // 代替文は名前。空の alt は「飾りなので読み上げ不要」の意味になる
          `<img src="${escapeXml(entry.iconHref)}" alt="${escapeXml(
            entry.name
          )}" />`,
          "</div>",
        ]
      : []),
    `<p class="character-name">${nameFragment(entry)}</p>`,
    ...(summary
      ? [`<p class="character-summary">${escapeXml(summary)}</p>`]
      : []),
    "</div>",
  ];
}

/**
 * 名前。読み仮名があればルビにする。
 *
 * **どの経路も `escapeXml` を通る。** XHTMLはXMLなので、人名の `&` が
 * 生のまま出ると本ごと開けなくなる（本文の組み方と同じ約束）。
 */
function nameFragment(entry: EpubCharacterEntry): string {
  const name = escapeXml(entry.name);
  const reading = (entry.reading ?? "").trim();
  return reading
    ? `<ruby>${name}<rt>${escapeXml(reading)}</rt></ruby>`
    : name;
}
