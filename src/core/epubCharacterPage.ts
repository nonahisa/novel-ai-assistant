import type { Character } from "../models/character";
import {
  DEFAULT_CHARACTER_RUBY_MODE,
  pageLayoutClassSuffix,
  type BookPageLayouts,
  type CharacterRubyMode,
} from "../models/book";
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
 *
 * **名前の空の人物は落とす。** 台帳には抽出の途中で作られた名前の無い
 * レコードが混ざることがあり、そのまま組むと中身の無い枠が本に並ぶ
 * （読者から見れば意味の無い空白である）。ここで落とすので、画面の
 * 「◯人が載ります」にも入らない——**見えている人数と本の中身がずれない**。
 */
export function selectBookCharacters(
  characters: readonly Character[]
): Character[] {
  return characters.filter(
    (character) =>
      character.name.trim() !== "" &&
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
 *
 * **名前の空の人物は、枠ごと出さない。** 名前が無ければ誰の欄なのか読者に
 * 分からず、絵と紹介文だけが宙に浮く。載せる人を選ぶのは
 * `selectBookCharacters` だが、ここが最後の関所である（選び方を変えても
 * 空の枠は出ない）。
 */
export function buildCharacterPageFragment(
  entries: readonly EpubCharacterEntry[],
  /** 面ごとの文字の体裁（作者の依頼、2026-09-13）。人物紹介のぶんを見る */
  pageLayouts?: BookPageLayouts,
  /** 名前のルビの範囲（作者の指定、2026-09-13）。**省略＝すべてに付ける** */
  rubyMode?: CharacterRubyMode
): string {
  return [
    // 面ごとの体裁を当てる手がかり。**選んでいなければクラスも付かない**
    `<section class="characters${pageLayoutClassSuffix(
      "characters",
      pageLayouts
    )}">`,
    '<h1 class="characters-heading">登場人物</h1>',
    ...entries
      .filter((entry) => entry.name.trim() !== "")
      .flatMap((entry) => characterFragment(entry, rubyMode)),
    "</section>",
  ].join("\n");
}

function characterFragment(
  entry: EpubCharacterEntry,
  rubyMode: CharacterRubyMode | undefined
): string[] {
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
    `<p class="character-name">${nameFragment(entry, rubyMode)}</p>`,
    ...(summary
      ? [`<p class="character-summary">${escapeXml(summary)}</p>`]
      : []),
    "</div>",
  ];
}

/**
 * 名前。読み仮名があり、**選んだ範囲に当てはまれば**ルビにする。
 *
 * **どの経路も `escapeXml` を通る。** XHTMLはXMLなので、人名の `&` が
 * 生のまま出ると本ごと開けなくなる（本文の組み方と同じ約束）。
 */
function nameFragment(
  entry: EpubCharacterEntry,
  rubyMode: CharacterRubyMode | undefined
): string {
  const name = escapeXml(entry.name);
  const reading = (entry.reading ?? "").trim();
  return reading && shouldRubyName(entry.name, rubyMode)
    ? `<ruby>${name}<rt>${escapeXml(reading)}</rt></ruby>`
    : name;
}

/**
 * 漢字が1文字でもあるか。
 *
 * `\p{Script=Han}` にしてあるのは、範囲を手で並べると常用外の漢字や
 * 異体字を取りこぼすためである（「髙」「琲」のような字が名前に入る）。
 */
const HAS_KANJI = /\p{Script=Han}/u;

/**
 * この名前にルビを振るか（作者の指定、2026-09-13）。
 *
 * **省略は `all`**（いままでと同じ）。`kanjiOnly` は**漢字が1文字でも
 * あれば付ける**——「ターナ先生」のように仮名と漢字が混ざる名前は、
 * 漢字の側の読みが要るので落とさない。
 */
export function shouldRubyName(
  name: string,
  mode: CharacterRubyMode | undefined
): boolean {
  const resolved = mode ?? DEFAULT_CHARACTER_RUBY_MODE;
  if (resolved === "none") return false;
  if (resolved === "kanjiOnly") return HAS_KANJI.test(name);
  return true;
}
