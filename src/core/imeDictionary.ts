import type { Character } from "../models/character";
import type { Ability } from "../models/ability";
import type { Location } from "../models/location";
import { deriveReading } from "./reading";

/**
 * IMEのユーザー辞書に取り込むデータを作る。
 *
 * 作品固有の固有名詞は変換で出てこないため、毎回打ち直すことになる。
 * 抽出済みの設定から辞書を書き出して取り込めば、変換で候補に出る。
 *
 * 種別ごとに品詞を分けるのは、ただ並べるより変換の精度が上がるため。
 */

export type ImeDialect = "msime" | "google";

/** 辞書1行 */
export interface DictionaryEntry {
  /** ひらがなの読み */
  reading: string;
  /** 変換後の表記 */
  surface: string;
  /** 品詞 */
  partOfSpeech: string;
}

export interface DictionaryBuildInput {
  characters: Character[];
  abilities: Ability[];
  locations: Location[];
}

export interface DictionaryBuildResult {
  entries: DictionaryEntry[];
  /** 読みが無くて出せなかった表記。作者に伝えて入力してもらう */
  missingReading: string[];
}

/**
 * 短すぎる表記は登録しない。
 * 「王」のような1文字の語は、普通の変換で出るうえに誤変換を増やす。
 */
const MIN_SURFACE_LENGTH = 2;

export function buildDictionary(
  input: DictionaryBuildInput
): DictionaryBuildResult {
  const entries: DictionaryEntry[] = [];
  const missing = new Set<string>();
  const seen = new Set<string>();

  const add = (
    surface: string,
    reading: string | null,
    partOfSpeech: string
  ) => {
    const text = surface.trim();
    if (text.length < MIN_SURFACE_LENGTH) return;

    // 名前そのものの読みが無ければ、カタカナからは作れるか試す
    const resolved = (reading?.trim() || deriveReading(text)) ?? "";
    if (!resolved) {
      missing.add(text);
      return;
    }

    const key = `${resolved}\t${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ reading: resolved, surface: text, partOfSpeech });
  };

  for (const character of input.characters) {
    // モブは数が多く、地の文の普通名詞と重なりやすいので辞書に入れない
    if (character.isMob) continue;
    add(character.name, character.reading, "人名");
    // 別名は名前の読みを流用できない。カタカナなら作れる
    for (const alias of character.aliases) add(alias, null, "人名");
  }

  for (const location of input.locations) {
    add(location.name, location.reading, "地名");
    for (const alias of location.aliases) add(alias, null, "地名");
  }

  for (const ability of input.abilities) {
    add(ability.name, ability.reading, "名詞");
    for (const alias of ability.aliases) add(alias, null, "名詞");
  }

  entries.sort(
    (a, b) =>
      a.reading.localeCompare(b.reading, "ja") ||
      a.surface.localeCompare(b.surface, "ja")
  );

  return { entries, missingReading: [...missing].sort() };
}

export interface DictionaryFormat {
  dialect: ImeDialect;
  label: string;
  fileName: string;
  /** 取り込み手順。書き出したあと画面に出す */
  howTo: string;
  /**
   * 文字コード。Microsoft IMEのテキスト取り込みはUTF-16を前提とするため、
   * プロバイダーごとに変える必要がある。
   */
  encoding: "utf16le" | "utf8";
}

export const DICTIONARY_FORMATS: Record<ImeDialect, DictionaryFormat> = {
  msime: {
    dialect: "msime",
    label: "Microsoft IME",
    fileName: "ime辞書_MSIME.txt",
    howTo:
      "IMEを右クリック →「単語の追加」→「ユーザー辞書ツール」→" +
      "「ツール」→「テキストファイルからの登録」で取り込めます。",
    encoding: "utf16le",
  },
  google: {
    dialect: "google",
    label: "Google日本語入力・Mozc",
    fileName: "ime辞書_Google.txt",
    howTo:
      "IMEを右クリック →「辞書ツール」→「管理」→" +
      "「新規辞書にインポート」で取り込めます。",
    encoding: "utf8",
  },
};

/**
 * 辞書ファイルの中身を組み立てる。
 *
 * どちらもタブ区切りだが、Google日本語入力は4列目にコメントを持てる。
 * どの作品から来た語なのかを残しておくと、あとで見分けられる。
 */
export function formatDictionary(
  entries: DictionaryEntry[],
  dialect: ImeDialect,
  workTitle: string
): string {
  const lines = entries.map((entry) => {
    const columns = [entry.reading, entry.surface, entry.partOfSpeech];
    if (dialect === "google") columns.push(workTitle);
    return columns.join("\t");
  });
  // 末尾に改行を入れないと、最後の1行が取り込まれないIMEがある
  return lines.length > 0 ? `${lines.join("\r\n")}\r\n` : "";
}

/** 書き出すバイト列。Microsoft IME向けはBOM付きUTF-16LEにする */
export function encodeDictionary(
  text: string,
  encoding: DictionaryFormat["encoding"]
): Uint8Array {
  if (encoding === "utf16le") {
    return new Uint8Array(Buffer.from(`﻿${text}`, "utf16le"));
  }
  return new TextEncoder().encode(text);
}
