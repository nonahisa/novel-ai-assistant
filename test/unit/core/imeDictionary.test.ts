import { describe, expect, test } from "vitest";
import {
  buildDictionary,
  buildDictionaryPickItems,
  encodeDictionary,
  formatDictionary,
  splitByEncodable,
  summarizeForComment,
  type DictionaryEntry,
} from "../../src/core/imeDictionary";
import { emptyCharacter, type Character } from "../../src/models/character";
import { emptyLocation, type Location } from "../../src/models/location";
import { emptyAbility, type Ability } from "../../src/models/ability";
import { emptyOrganization } from "../../src/models/organization";
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
      {
        reading: "うぇるふぇあ",
        surface: "ウェルフェア",
        partOfSpeech: "地名",
        kind: "location",
      },
      {
        reading: "しんじゅつ",
        surface: "シンジュツ",
        partOfSpeech: "名詞",
        kind: "ability",
      },
      {
        reading: "ほんごー",
        surface: "ホンゴー",
        partOfSpeech: "人名",
        kind: "character",
      },
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
      kind: "character",
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
      {
        reading: "つきしまあかり",
        surface: "月島灯",
        partOfSpeech: "人名",
        kind: "character",
      },
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
      {
        reading: "せいもん",
        surface: "セイモン",
        partOfSpeech: "名詞",
        kind: "term",
      },
    ]);
  });

  test("漢字の造語も、読みが入っていれば登録する", () => {
    // 世界観に読みの項目が無かった頃は、漢字の造語は
    // `deriveReading` が必ず諦めるため**どうやっても辞書に入らなかった**。
    // 作品の造語こそ変換に出てこないので、ここが抜けているのは痛かった。
    const result = buildDictionary({
      characters: [],
      abilities: [],
      locations: [],
      worldItems: [
        {
          ...emptyWorldItem("world_001", "神威術"),
          category: "term",
          reading: "しんじゅつ",
        },
      ],
    });

    expect(result.entries).toEqual([
      {
        reading: "しんじゅつ",
        surface: "神威術",
        partOfSpeech: "名詞",
        kind: "term",
      },
    ]);
    expect(result.missingReading).toEqual([]);
  });

  test("漢字の造語で読みが空なら、黙って落とさず作者に伝える", () => {
    const result = buildDictionary({
      characters: [],
      abilities: [],
      locations: [],
      worldItems: [
        { ...emptyWorldItem("world_001", "神術"), category: "term" },
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.missingReading).toEqual(["神術"]);
  });

  test("世界観の読みがカタカナでも、ひらがなへ直して登録する", () => {
    // IMEの辞書は読みがひらがなでないと取り込めない。
    // P-16の推定や作者の入力でカタカナが入る余地があるので、
    // 他の種別と同じくコード側で直す
    const result = buildDictionary({
      characters: [],
      abilities: [],
      locations: [],
      worldItems: [
        {
          ...emptyWorldItem("world_001", "神術"),
          category: "term",
          reading: "シンジュツ",
        },
      ],
    });

    expect(result.entries).toEqual([
      {
        reading: "しんじゅつ",
        surface: "神術",
        partOfSpeech: "名詞",
        kind: "term",
      },
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
  const entries: DictionaryEntry[] = [
    {
      reading: "ほんごー",
      surface: "ホンゴー",
      partOfSpeech: "人名",
      kind: "character",
    },
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

  test("ATOKは3列（4列目を持てるか未確認のため足さない）", () => {
    expect(formatDictionary(entries, "atok", "テスト作品")).toBe(
      "ほんごー\tホンゴー\t人名\r\n"
    );
  });

  test("ATOK向けはShift_JISで書き出す", () => {
    const bytes = encodeDictionary("あ", "shift_jis");

    // 「あ」= Shift_JIS 0x82A0。BOMは付けない
    expect([...bytes]).toEqual([0x82, 0xa0]);
  });
});

describe("文字コードで表せない語の選り分け", () => {
  /**
   * Shift_JISには無い文字がある。`iconv-lite` は黙って `?` に落とすので、
   * そのまま書き出すと化けた辞書ができあがり、
   * 作者には「登録したのに変な語が出る」としか見えない。
   */
  const ok: DictionaryEntry = {
    reading: "ほんごー",
    surface: "ホンゴー",
    partOfSpeech: "人名",
    kind: "character",
  };
  // 「𠮷」（つちよし）はサロゲートペアでShift_JISに無い。人名では現実的に起きる
  const lost: DictionaryEntry = {
    reading: "よしの",
    surface: "𠮷野",
    partOfSpeech: "人名",
    kind: "character",
  };

  test("Shift_JISで表せない語は書き出さず、名前を返す", () => {
    const result = splitByEncodable([ok, lost], "shift_jis");

    expect(result.usable).toEqual([ok]);
    expect(result.unencodable).toEqual(["𠮷野"]);
  });

  test("小説でよく使う記号はShift_JISでも通る", () => {
    // 「――」「｜《》」「……」が落ちるなら記号辞書の設計を変える必要がある。
    // 実測では通ったので、その事実を固定しておく
    const symbols: DictionaryEntry[] = [
      {
        reading: "だっしゅ",
        surface: "――",
        partOfSpeech: "短縮よみ",
        kind: "term",
      },
      {
        reading: "るび",
        surface: "｜《》",
        partOfSpeech: "短縮よみ",
        kind: "term",
      },
      {
        reading: "さんてん",
        surface: "……",
        partOfSpeech: "短縮よみ",
        kind: "term",
      },
    ];

    const result = splitByEncodable(symbols, "shift_jis");

    expect(result.usable).toEqual(symbols);
    expect(result.unencodable).toEqual([]);
  });

  test("UTF-8・UTF-16では何も落とさない", () => {
    expect(splitByEncodable([ok, lost], "utf8").unencodable).toEqual([]);
    expect(splitByEncodable([ok, lost], "utf16le").unencodable).toEqual([]);
  });
});

describe("コメントに入れる解説", () => {
  test("タブと改行は空白へ畳む", () => {
    // 辞書ファイルはタブ区切り・CRLF区切り。残すとその1行が壊れ、
    // 作者からは「登録したはずの語だけ変換に出ない」としか見えない
    expect(summarizeForComment("聖なる\t言葉。\r\n王都で使う")).toBe(
      "聖なる 言葉。 王都で使う"
    );
  });

  test("30字を超えたら切って「…」を付ける", () => {
    // IMEの辞書ツールのコメント列は狭い。長い紹介を丸ごと入れても読めない
    expect(summarizeForComment("あ".repeat(30))).toBe("あ".repeat(30));
    expect(summarizeForComment("あ".repeat(31))).toBe(`${"あ".repeat(30)}…`);
  });

  test("サロゲートペアを割らない", () => {
    // 「𠮷」のような字を途中で切ると、壊れた文字がコメントに残る
    const text = "𠮷".repeat(31);
    expect(summarizeForComment(text)).toBe(`${"𠮷".repeat(30)}…`);
  });

  test("空や未設定なら空文字", () => {
    expect(summarizeForComment(null)).toBe("");
    expect(summarizeForComment("   ")).toBe("");
  });
});

describe("解説つきのコメント", () => {
  function withNote() {
    return buildDictionary({
      characters: [
        character("char_001", "ホンゴー", {
          summary: "主人公。転生した少女",
          aliases: ["ホンゴ"],
        }),
      ],
      abilities: [],
      locations: [],
    });
  }

  test("Google日本語入力の4列目は「作品名：解説」", () => {
    // 作品名だけだと、何百と並んだ造語のどれが何だったのか分からない
    const result = withNote();
    const line = formatDictionary(result.entries, "google", "テスト作品");

    expect(line).toContain("ほんごー\tホンゴー\t人名\tテスト作品：主人公。転生した少女\r\n");
  });

  test("解説が無ければ作品名だけを入れる", () => {
    // 「テスト作品：」と尻切れにしない
    const entries: DictionaryEntry[] = [
      {
        reading: "ほんごー",
        surface: "ホンゴー",
        partOfSpeech: "人名",
        kind: "character",
      },
    ];

    expect(formatDictionary(entries, "google", "テスト作品")).toBe(
      "ほんごー\tホンゴー\t人名\tテスト作品\r\n"
    );
  });

  test("解説があってもMicrosoft IMEとATOKは3列のまま", () => {
    // 4列目を持てるか確かめられていない。当てずっぽうで足すと
    // 取り込みが丸ごと失敗しかねない
    const result = withNote();

    expect(formatDictionary(result.entries, "msime", "テスト作品")).toBe(
      "ほんご\tホンゴ\t人名\r\nほんごー\tホンゴー\t人名\r\n"
    );
    expect(formatDictionary(result.entries, "atok", "テスト作品")).toBe(
      "ほんご\tホンゴ\t人名\r\nほんごー\tホンゴー\t人名\r\n"
    );
  });

  test("別名にも本体と同じ解説が付く", () => {
    // 一覧で「ホンゴ」だけ見せられても、誰のことか分からない
    const result = withNote();

    expect(
      result.entries.find((entry) => entry.surface === "ホンゴ")?.note
    ).toBe("主人公。転生した少女");
  });

  test("人物の紹介が無ければ役割を使う", () => {
    const result = build({
      characters: [character("char_001", "ホンゴー", { role: "主人公" })],
    });

    expect(result.entries[0].note).toBe("主人公");
  });

  test("場所・組織・能力・世界観は紹介、無ければ説明を使う", () => {
    const result = buildDictionary({
      characters: [],
      abilities: [
        { ...emptyAbility("abil_001", "シンジュツ"), description: "神の術" },
      ],
      locations: [
        { ...emptyLocation("loc_001", "ウェルフェア"), summary: "王都" },
      ],
      organizations: [
        {
          ...emptyOrganization("org_001", "アウクトケ"),
          summary: "名門の家",
          description: "こちらは使わない",
        },
      ],
      worldItems: [
        {
          ...emptyWorldItem("world_001", "セイモン"),
          category: "term",
          description: "詠唱に使う言葉",
        },
      ],
    });

    const noteOf = (surface: string) =>
      result.entries.find((entry) => entry.surface === surface)?.note;

    expect(noteOf("シンジュツ")).toBe("神の術");
    expect(noteOf("ウェルフェア")).toBe("王都");
    // 紹介があるときは説明より紹介を優先する（短くまとめてあるため）
    expect(noteOf("アウクトケ")).toBe("名門の家");
    expect(noteOf("セイモン")).toBe("詠唱に使う言葉");
  });
});

describe("辞書に入れる語を選ぶ一覧", () => {
  function sample() {
    return buildDictionary({
      characters: [character("char_001", "ホンゴー", { summary: "主人公" })],
      abilities: [{ ...emptyAbility("abil_001", "シンジュツ") }],
      locations: [{ ...emptyLocation("loc_001", "ウェルフェア") }],
    });
  }

  test("種類ごとに区切り線を挟む", () => {
    // 品詞では組織も能力も造語も「名詞」に畳まれていて、作者が見分けられない
    const items = buildDictionaryPickItems(sample().entries);

    expect(
      items.map((item) => (item.separator ? `--${item.label}--` : item.label))
    ).toEqual([
      "--人物--",
      "ホンゴー",
      "--場所--",
      "ウェルフェア",
      "--能力--",
      "シンジュツ",
    ]);
  });

  test("既定はすべて選択済み", () => {
    // 数百件を毎回選び直させると使われなくなる。
    // この一覧は「ふるいにかける」ためではなく「要らないものを外す」ためにある
    const items = buildDictionaryPickItems(sample().entries);

    expect(
      items.filter((item) => !item.separator).every((item) => item.picked)
    ).toBe(true);
  });

  test("前回外した語は外れた状態で出す", () => {
    const items = buildDictionaryPickItems(sample().entries, ["ウェルフェア"]);
    const picked = new Map(
      items
        .filter((item) => !item.separator)
        .map((item) => [item.label, item.picked])
    );

    expect(picked.get("ウェルフェア")).toBe(false);
    expect(picked.get("ホンゴー")).toBe(true);
    expect(picked.get("シンジュツ")).toBe(true);
  });

  test("読みと解説を項目に添える", () => {
    const items = buildDictionaryPickItems(sample().entries);
    const honngo = items.find((item) => item.label === "ホンゴー");

    expect(honngo?.description).toBe("ほんごー");
    expect(honngo?.detail).toBe("主人公");
  });

  test("語の無い種類は区切り線を出さない", () => {
    // 空の「組織」だけが並ぶと、抽出できていないのか不具合なのか分からない
    const items = buildDictionaryPickItems(sample().entries);

    expect(
      items.some((item) => item.separator && item.label === "組織")
    ).toBe(false);
  });
});
