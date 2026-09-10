import iconv = require("iconv-lite");
import type { Character } from "../models/character";
import type { Ability } from "../models/ability";
import type { Location } from "../models/location";
import type { Organization } from "../models/organization";
import type { WorldItem } from "../models/world";
import { deriveReading, toDictionaryReading } from "./reading";

/**
 * IMEのユーザー辞書に取り込むデータを作る。
 *
 * 作品固有の固有名詞は変換で出てこないため、毎回打ち直すことになる。
 * 抽出済みの設定から辞書を書き出して取り込めば、変換で候補に出る。
 *
 * 種別ごとに品詞を分けるのは、ただ並べるより変換の精度が上がるため。
 */

export type ImeDialect = "msime" | "google" | "atok";

/**
 * 語の出どころの種類。
 *
 * 品詞（人名・地名・名詞）とは別に持つ。品詞はIMEの都合で畳まれており
 * （組織も能力も造語も「名詞」）、**作者が一覧で見分けるには足りない。**
 */
export type DictionaryKind =
  | "character"
  | "location"
  | "organization"
  | "ability"
  | "term";

/** 一覧の区切り線に出す名前 */
export const DICTIONARY_KIND_LABELS: Record<DictionaryKind, string> = {
  character: "人物",
  location: "場所",
  organization: "組織",
  ability: "能力",
  term: "用語",
};

/** 一覧に並べる順。設定資料パネルと同じ並びにして、探す場所を揃える */
export const DICTIONARY_KIND_ORDER: readonly DictionaryKind[] = [
  "character",
  "location",
  "organization",
  "ability",
  "term",
];

/** 辞書1行 */
export interface DictionaryEntry {
  /** ひらがなの読み */
  reading: string;
  /** 変換後の表記 */
  surface: string;
  /** 品詞 */
  partOfSpeech: string;
  /** 語の出どころ。一覧の区切りに使う */
  kind: DictionaryKind;
  /**
   * 短い解説。一覧の説明と、コメント欄を持てる形式の4列目に出す。
   * 元のレコードに書くものが無ければ入らない（空文字は持たない）
   */
  note?: string;
}

export interface DictionaryBuildInput {
  characters: Character[];
  abilities: Ability[];
  locations: Location[];
  organizations?: Organization[];
  /** 世界観。このうち「固有の用語」だけを辞書に入れる（下記の理由） */
  worldItems?: WorldItem[];
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

/**
 * コメントに入れる解説の長さ。
 *
 * 紹介（`SUMMARY_MAX_CHARS` = 80字）をそのまま入れない。辞書のコメント欄は
 * IMEの辞書ツールの狭い列に出るもので、長い文はどのIMEでも読めない。
 * ここで要るのは「どの語だったか思い出せる手がかり」だけなので短く切る。
 * 一覧の説明欄（QuickPickの `detail`）でも同じ理由で読みやすい。
 */
export const COMMENT_MAX_CHARS = 30;

/**
 * 解説をコメント欄へ入れられる形に整える。
 *
 * **タブと改行を必ず落とす。** 辞書ファイルはタブ区切り・CRLF区切りなので、
 * 元の紹介文に混じっていると**その1行が壊れて取り込みで弾かれる。**
 * 作者から見れば「登録したはずの語だけ出てこない」という分かりにくい形になる。
 */
export function summarizeForComment(text: string | null | undefined): string {
  if (!text) return "";
  // タブ・改行を含む空白の連なりを、ひと続きの空白1つに畳む。
  // 取り除くのではなく空白へ替えるのは、改行で区切られた文が
  // 「見えた廊下奥に」のようにくっついて読めなくなるため
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";

  // サロゲートペア（「𠮷」のような字）を割らないよう、コードポイントで数える
  const characters = [...flat];
  if (characters.length <= COMMENT_MAX_CHARS) return flat;
  return `${characters.slice(0, COMMENT_MAX_CHARS).join("")}…`;
}

export function buildDictionary(
  input: DictionaryBuildInput
): DictionaryBuildResult {
  const entries: DictionaryEntry[] = [];
  const missing = new Set<string>();
  const seen = new Set<string>();

  const add = (
    surface: string,
    reading: string | null,
    partOfSpeech: string,
    kind: DictionaryKind,
    note: string
  ) => {
    const text = surface.trim();
    if (text.length < MIN_SURFACE_LENGTH) return;

    // 名前そのものの読みが無ければ、カタカナからは作れるか試す
    const raw = reading?.trim() || deriveReading(text);
    // **IMEの辞書は読みがひらがなでないと取り込めない。**
    // AIはひらがなを指示してもカタカナで返すことがあり、
    // そのまま書き出すとその行が取り込みで弾かれる。
    // 直せるものは直し、直せないものは作者に伝える
    const resolved = raw ? toDictionaryReading(raw) : undefined;
    if (!resolved) {
      missing.add(text);
      return;
    }

    const key = `${resolved}\t${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      reading: resolved,
      surface: text,
      partOfSpeech,
      kind,
      // 空文字は持たない。持つと4列目が「作品名：」と尻切れになる
      ...(note ? { note } : {}),
    });
  };

  for (const character of input.characters) {
    // モブは数が多く、地の文の普通名詞と重なりやすいので辞書に入れない
    if (character.isMob) continue;
    // 紹介が無ければ役割（「主人公」等）で代える。
    // どちらも無い人物は解説なしで出す（無理に本文から作らない）
    const note = summarizeForComment(character.summary ?? character.role);
    add(character.name, character.reading, "人名", "character", note);
    // 別名は名前の読みを流用できない。カタカナなら作れる。
    // 解説は本体と同じものを付ける——別名だけ手がかりが無いと、
    // 一覧で「リン」だけ見せられても誰のことか分からない
    for (const alias of character.aliases) {
      add(alias, null, "人名", "character", note);
    }
  }

  for (const location of input.locations) {
    const note = summarizeForComment(location.summary ?? location.description);
    add(location.name, location.reading, "地名", "location", note);
    for (const alias of location.aliases) {
      add(alias, null, "地名", "location", note);
    }
  }

  // 組織名は固有名詞だが、IMEに「組織名」という品詞は無い。
  // 人名でも地名でもないので名詞にする
  for (const organization of input.organizations ?? []) {
    const note = summarizeForComment(
      organization.summary ?? organization.description
    );
    add(organization.name, organization.reading, "名詞", "organization", note);
    for (const alias of organization.aliases) {
      add(alias, null, "名詞", "organization", note);
    }
  }

  for (const ability of input.abilities) {
    const note = summarizeForComment(ability.summary ?? ability.description);
    add(ability.name, ability.reading, "名詞", "ability", note);
    for (const alias of ability.aliases) {
      add(alias, null, "名詞", "ability", note);
    }
  }

  // 世界観は**「固有の用語」だけ**を入れる。
  // 作品の造語（分類 `term`）こそ変換で出てこないので、
  // 辞書に無いと作者が毎回打ち直すことになる。
  // 一方「詠唱の制約」のような見出し（`rule` や `society` など）は
  // 何についての項目かを示すための言葉で、本文で打つものではない。
  //
  // 読みは `item.reading` を使う。以前は世界観に読みの項目が無く、
  // **漢字の造語はどうやっても辞書に入らなかった**（カタカナしか作れなかった）。
  // 作品の造語こそ変換に出てこないので、そこが抜けているのは痛かった。
  for (const item of input.worldItems ?? []) {
    if (item.category !== "term") continue;
    // 世界観には紹介の項目が無く、`description` がその項目の中身そのもの
    const note = summarizeForComment(item.description);
    add(item.name, item.reading, "名詞", "term", note);
    // 別名は名前の読みを流用できない。カタカナなら作れる
    for (const alias of item.aliases) add(alias, null, "名詞", "term", note);
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
   * 文字コード。Microsoft IMEのテキスト取り込みはUTF-16を前提とし、
   * ATOKは伝統的にShift_JISのため、プロバイダーごとに変える必要がある。
   * 名前は `textFile.ts` の `Encoding` と揃える（同じ `iconv-lite` を使う）。
   */
  encoding: "utf16le" | "utf8" | "shift_jis";
  /**
   * 品詞名の読み替え。IMEによって品詞の呼び方が違う。
   * 載っていない品詞はそのまま出す。
   */
  partOfSpeechMap?: Record<string, string>;
  /**
   * 既定で選んだ状態にするか。
   * 確かめられていない形式まで既定で書き出すと、
   * 使えないファイルが作品フォルダに増え、Git同期にも乗ってしまう。
   */
  defaultPicked: boolean;
  /** 形式についての但し書き。選択画面に出す */
  note?: string;
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
    defaultPicked: true,
  },
  google: {
    dialect: "google",
    label: "Google日本語入力・Mozc",
    fileName: "ime辞書_Google.txt",
    howTo:
      "IMEを右クリック →「辞書ツール」→「管理」→" +
      "「新規辞書にインポート」で取り込めます。",
    encoding: "utf8",
    defaultPicked: true,
  },
  /**
   * ATOK（作者の要望、2026-08-15）。
   *
   * **未検証。** 開発環境にATOKが無く、形式を実際に確かめられていない。
   * 分かっていないのは次の3点で、作者がATOKで取り込んで初めて確定する。
   *
   * 1. 文字コードがShift_JISでよいか（新しいATOKはUTF-8も受けるかもしれない）
   * 2. 品詞名がMS-IMEと同じ「人名」「地名」「名詞」でよいか
   *    → 確かめられるまで読み替えない（`partOfSpeechMap` を置かない）。
   *      当てずっぽうの名前を入れると、通らない原因が増えるだけになる
   * 3. 4列目（コメント）を持てるか → 持てない前提で3列にしておく
   */
  atok: {
    dialect: "atok",
    label: "ATOK（未検証）",
    fileName: "ime辞書_ATOK.txt",
    howTo:
      "ATOKメニュー →「辞書メンテナンス」→「辞書ユーティリティ」→" +
      "「一括処理」→「単語情報の一括登録」で取り込めます。",
    encoding: "shift_jis",
    defaultPicked: false,
    note:
      "この形式はまだ実機で確かめていません。" +
      "取り込めたか・エラーが出たかを教えていただけると直せます。",
  },
};

/**
 * 辞書ファイルの中身を組み立てる。
 *
 * どちらもタブ区切りだが、Google日本語入力は4列目にコメントを持てる。
 * ここに**作品名と短い解説**を入れる（作者の依頼、2026-09-10）。
 * 作品名だけだと、IMEの辞書ツールに何百と並んだ造語のうち
 * どれが何だったのか、作者自身にも分からなくなる。
 *
 * MS-IMEとATOKは3列のまま。コメント欄を持てるか確かめられていないので、
 * 当てずっぽうで4列目を足すと取り込みが丸ごと失敗しかねない。
 */
export function formatDictionary(
  entries: DictionaryEntry[],
  dialect: ImeDialect,
  workTitle: string
): string {
  const map = DICTIONARY_FORMATS[dialect].partOfSpeechMap;
  const lines = entries.map((entry) => {
    const partOfSpeech = map?.[entry.partOfSpeech] ?? entry.partOfSpeech;
    const columns = [entry.reading, entry.surface, partOfSpeech];
    if (dialect === "google") {
      columns.push(entry.note ? `${workTitle}：${entry.note}` : workTitle);
    }
    return columns.join("\t");
  });
  // 末尾に改行を入れないと、最後の1行が取り込まれないIMEがある
  return lines.length > 0 ? `${lines.join("\r\n")}\r\n` : "";
}

/**
 * 前回外した語の控えの鍵（`globalState`）。**作品ごとに分ける。**
 *
 * 「この語は辞書に要らない」という判断は作品の中身に紐づく。
 * 作品をまたいで共通にすると、別の作品で同じ表記の語が黙って落ちる。
 */
export const IME_EXCLUDED_KEY_PREFIX = "novelai.imeDictionary.excluded.";

export function imeExcludedKey(workId: string): string {
  return `${IME_EXCLUDED_KEY_PREFIX}${workId}`;
}

/**
 * 一覧に出す項目。**VS Codeの型に寄せない**（`core` はUIを知らない）。
 * 呼び出し側が `vscode.QuickPickItem` へ移し替える。
 */
export interface DictionaryPickItem {
  /** 種類の区切り線か。true のときは `label` だけを使う */
  separator: boolean;
  /** 区切り線なら種類名、語なら表記 */
  label: string;
  /** 語の読み */
  description?: string;
  /** 短い解説 */
  detail?: string;
  /** 既定でチェックが入っているか */
  picked: boolean;
  /** 語の項目のときだけ入る。選ばれた語を書き出しへ渡すのに使う */
  entry?: DictionaryEntry;
}

/**
 * 辞書に入れる語を選ぶ一覧を組む（作者の依頼、2026-09-10）。
 *
 * **既定は全部選択にする。** 6.13.2のとおり「入れる価値がある語かどうか」は
 * すでに読みの有無で絞り込まれており、ここまで来た語は基本的に入れてよい。
 * 既定を空にすると、数百件を毎回選び直すことになって使われなくなる。
 * この一覧は「ふるいにかける」ためではなく「**要らないものを外す**」ためにある。
 *
 * 種類ごとに区切るのは、品詞（人名・地名・名詞）では組織・能力・造語が
 * すべて「名詞」に畳まれていて、作者が見分けられないため。
 */
export function buildDictionaryPickItems(
  entries: DictionaryEntry[],
  excluded: readonly string[] = []
): DictionaryPickItem[] {
  const dropped = new Set(excluded);
  const items: DictionaryPickItem[] = [];

  for (const kind of DICTIONARY_KIND_ORDER) {
    const group = entries.filter((entry) => entry.kind === kind);
    // 中身の無い見出しは出さない。空の「組織」だけが並ぶと、
    // 抽出できていないのか表示の不具合なのか分からない
    if (group.length === 0) continue;

    items.push({
      separator: true,
      label: DICTIONARY_KIND_LABELS[kind],
      picked: false,
    });
    for (const entry of group) {
      items.push({
        separator: false,
        label: entry.surface,
        description: entry.reading,
        detail: entry.note || undefined,
        // 前回外した語だけチェックを外して出す
        picked: !dropped.has(entry.surface),
        entry,
      });
    }
  }

  return items;
}

/**
 * その文字コードで表せる語だけを選り分ける。
 *
 * **Shift_JISには無い文字がある。** `｜`『――』のような記号や、
 * 作品によっては人名の漢字が入らない。`iconv-lite` は表せない文字を
 * 黙って `?` に落とすので、そのまま書き出すと**化けた辞書ができあがる。**
 * 作者から見れば「登録したのに変な語が出る」という分かりにくい形になる。
 *
 * `textFile.ts` の `encodeFragment` と同じ考え方で、往復変換して
 * 元に戻らないものは**書き出さずに作者へ伝える**。
 * 「保存できた」ことにして中身を壊すより、入らなかったと伝えるほうがよい。
 */
export function splitByEncodable(
  entries: DictionaryEntry[],
  encoding: DictionaryFormat["encoding"]
): { usable: DictionaryEntry[]; unencodable: string[] } {
  // UTF-8とUTF-16はどの文字も表せるので、選り分ける必要がない
  if (encoding !== "shift_jis") {
    return { usable: entries, unencodable: [] };
  }

  const usable: DictionaryEntry[] = [];
  const unencodable: string[] = [];
  for (const entry of entries) {
    const text = `${entry.reading}\t${entry.surface}\t${entry.partOfSpeech}`;
    if (iconv.decode(iconv.encode(text, "shift_jis"), "shift_jis") === text) {
      usable.push(entry);
    } else {
      unencodable.push(entry.surface);
    }
  }
  return { usable, unencodable };
}

/**
 * 書き出すバイト列。
 * Microsoft IME向けはBOM付きUTF-16LE、ATOK向けはShift_JISにする。
 *
 * **Shift_JISで表せない文字が残っていないことは呼び出し側の責任**
 * （先に `splitByEncodable` で除いておく）。ここで落とすと、
 * どの語が消えたのか呼び出し側が知れなくなる。
 */
export function encodeDictionary(
  text: string,
  encoding: DictionaryFormat["encoding"]
): Uint8Array {
  if (encoding === "utf16le") {
    return new Uint8Array(Buffer.from(`﻿${text}`, "utf16le"));
  }
  if (encoding === "shift_jis") {
    return new Uint8Array(iconv.encode(text, "shift_jis"));
  }
  return new TextEncoder().encode(text);
}
