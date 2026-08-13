import { describe, expect, test } from "vitest";
import {
  buildDictionary,
  encodeDictionary,
  formatDictionary,
} from "../../src/core/imeDictionary";
import { emptyCharacter, type Character } from "../../src/models/character";
import { emptyLocation, type Location } from "../../src/models/location";
import { emptyAbility, type Ability } from "../../src/models/ability";
import { emptyWorldItem } from "../../src/models/world";

function character(
  id: string,
  name: string,
  overrides: Partial<Character> = {}
): Character {
  return { ...emptyCharacter(id, name), ...overrides };
}

function build(input: {
  characters?: Character[];
  abilities?: Ability[];
  locations?: Location[];
}) {
  return buildDictionary({
    characters: input.characters ?? [],
    abilities: input.abilities ?? [],
    locations: input.locations ?? [],
  });
}

describe("IME辞書の組み立て", () => {
  test("種別ごとに品詞を変える", () => {
    // ただ並べるより変換の精度が上がる
    const result = build({
      characters: [character("char_001", "ホンゴー")],
      locations: [{ ...emptyLocation("loc_001", "ウェルフェア") }],
      abilities: [{ ...emptyAbility("abil_001", "シンジュツ") }],
    });

    expect(result.entries).toEqual([
      { reading: "うぇるふぇあ", surface: "ウェルフェア", partOfSpeech: "地名" },
      { reading: "しんじゅつ", surface: "シンジュツ", partOfSpeech: "名詞" },
      { reading: "ほんごー", surface: "ホンゴー", partOfSpeech: "人名" },
    ]);
  });

  test("別名も登録する", () => {
    const result = build({
      characters: [
        character("char_001", "リンセップ・アウクト", { aliases: ["リン"] }),
      ],
    });

    expect(result.entries.map((entry) => entry.surface)).toEqual([
      "リン",
      "リンセップ・アウクト",
    ]);
  });

  test("読みが入っていればそれを使う", () => {
    // 作者が直した読みを機械的な変換で潰さない
    const result = build({
      characters: [character("char_001", "月島灯", { reading: "つきしまあかり" })],
    });

    expect(result.entries[0]).toEqual({
      reading: "つきしまあかり",
      surface: "月島灯",
      partOfSpeech: "人名",
    });
  });

  test("読みが決められない語は除いて、作者に知らせる", () => {
    const result = build({
      characters: [character("char_001", "月島灯")],
    });

    expect(result.entries).toEqual([]);
    // 黙って落とすと、なぜ辞書に無いのか分からない
    expect(result.missingReading).toEqual(["月島灯"]);
  });

  test("カタカナの読みはひらがなへ直して登録する", () => {
    // IMEの辞書は読みがひらがなでないと取り込めない。
    // AIはプロンプトでひらがなを指示していてもカタカナで返すことがある。
    // **AIの出力を信用せずコード側で直す**（他の項目と同じ扱い）
    const result = build({
      characters: [
        character("char_001", "月島灯", { reading: "ツキシマアカリ" }),
      ],
    });

    expect(result.entries).toEqual([
      { reading: "つきしまあかり", surface: "月島灯", partOfSpeech: "人名" },
    ]);
    expect(result.missingReading).toEqual([]);
  });

  test("ひらがなにできない読みは登録せず、作者に知らせる", () => {
    // 漢字や英字が混ざった読みを書き出すと、取り込みでその行が弾かれる。
    // 黙って壊れた辞書を渡すより、作者に直してもらう
    const result = build({
      characters: [
        character("char_001", "月島灯", { reading: "月島あかり" }),
        character("char_002", "白瀬澪", { reading: "shirase mio" }),
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.missingReading).toEqual(["月島灯", "白瀬澪"]);
  });

  test("世界観のうち「固有の用語」だけを登録する", () => {
    // 作品の造語こそ変換で出てこない。辞書に入れないと毎回打ち直しになる。
    // 一方「詠唱の制約」のような見出しは本文で打つ言葉ではないので入れない
    const result = buildDictionary({
      characters: [],
      abilities: [],
      locations: [],
      worldItems: [
        { ...emptyWorldItem("world_001", "セイモン"), category: "term" },
        { ...emptyWorldItem("world_002", "詠唱の制約"), category: "rule" },
      ],
    });

    expect(result.entries).toEqual([
      { reading: "せいもん", surface: "セイモン", partOfSpeech: "名詞" },
    ]);
  });

  test("モブは登録しない", () => {
    // 数が多く、地の文の普通名詞と重なりやすい
    const result = build({
      characters: [character("char_001", "トリシラベカンタチ", { isMob: true })],
    });

    expect(result.entries).toEqual([]);
  });

  test("1文字の語は登録しない", () => {
    // 普通の変換で出るうえ、誤変換を増やす
    const result = build({ characters: [character("char_001", "王")] });

    expect(result.entries).toEqual([]);
    expect(result.missingReading).toEqual([]);
  });

  test("同じ読みと表記の組は1つにまとめる", () => {
    const result = build({
      characters: [
        character("char_001", "リン"),
        character("char_002", "リンセップ", { aliases: ["リン"] }),
      ],
    });

    expect(
      result.entries.filter((entry) => entry.surface === "リン")
    ).toHaveLength(1);
  });

  test("読みの五十音順に並べる", () => {
    const result = build({
      characters: [
        character("char_001", "マルキオ"),
        character("char_002", "アンツ"),
        character("char_003", "ホンゴー"),
      ],
    });

    expect(result.entries.map((entry) => entry.reading)).toEqual([
      "あんつ",
      "ほんごー",
      "まるきお",
    ]);
  });
});

describe("辞書ファイルの書式", () => {
  const entries = [
    { reading: "ほんごー", surface: "ホンゴー", partOfSpeech: "人名" },
  ];

  test("Microsoft IMEは3列", () => {
    expect(formatDictionary(entries, "msime", "テスト作品")).toBe(
      "ほんごー\tホンゴー\t人名\r\n"
    );
  });

  test("Google日本語入力は4列目に作品名を入れる", () => {
    // どの作品から来た語なのか、あとで見分けられるようにする
    expect(formatDictionary(entries, "google", "テスト作品")).toBe(
      "ほんごー\tホンゴー\t人名\tテスト作品\r\n"
    );
  });

  test("語が無ければ空にする", () => {
    expect(formatDictionary([], "msime", "テスト作品")).toBe("");
  });

  test("Microsoft IME向けはBOM付きUTF-16LEで書き出す", () => {
    const bytes = encodeDictionary("あ\r\n", "utf16le");

    // BOM
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xfe);
    // 「あ」= U+3042 をリトルエンディアンで
    expect(bytes[2]).toBe(0x42);
    expect(bytes[3]).toBe(0x30);
  });

  test("Google日本語入力向けはUTF-8で書き出す", () => {
    const bytes = encodeDictionary("あ", "utf8");

    expect([...bytes]).toEqual([0xe3, 0x81, 0x82]);
  });
});
