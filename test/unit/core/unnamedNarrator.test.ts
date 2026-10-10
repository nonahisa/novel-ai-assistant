import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { validateCharacterExtractResult } from "../../../src/core/characterExtractionValidation";
import { mergeExtractedCharacters } from "../../../src/core/characterMerge";
import {
  replayExtraction,
  type ExtractionBaseline,
} from "../../../src/core/externalExtractMerge";
import { detectNarrator } from "../../../src/core/narrator";
import {
  findNarratorNameSlips,
  narratorNameForms,
} from "../../../src/core/narratorNameSlip";
import {
  describeUnnamedNarratorOutcome,
  firstPersonOfUnnamedNarratorName,
  unnamedNarratorName,
} from "../../../src/core/unnamedNarrator";
import { emptyCharacter, parseCharacter, type Character } from "../../../src/models/character";
import type { CharacterExtractResult } from "../../../src/prompts/characterExtract";

/**
 * 名前の出てこない一人称の語り手を「語り手（僕）」として登録する
 * （作者の裁定、2026-10-10「『語り手（僕）』で登録」）。
 *
 * 作者の作品「肉片とラジオと心霊現象」は、地の文が名前の出ない「僕」で
 * 書かれている。抽出は「僕」という名前で返し、検算が代名詞として捨てていたため、
 * 語り手を手がかりにする機能（語り手の決定・推敲の視点・名前のよじれ・
 * 矛盾検知の一人称）がこの作品では働かなかった。
 */

const NARRATION =
  "　僕は中学三年の夏、マンションの屋上で風に吹かれていた。\n" +
  "　ラジオから声が聞こえた。僕は耳を澄ませた。\n" +
  "「誰かいるの？」と管理人のおじいさんが言った。\n" +
  "　僕は返事をしなかった。\n";

function chunkOf(text: string, chapter = 1, hash = `h${chapter}`): Chunk {
  return {
    filePath: `本文/episode_000${chapter}.txt`,
    index: 0,
    text,
    startLine: 0,
    hash,
    chapterStart: chapter,
    chapterEnd: chapter,
  };
}

const CHUNK = chunkOf(NARRATION);

const NARRATOR_ANSWER: CharacterExtractResult = {
  characters: [
    {
      name: "僕",
      summary: "中学3年生の語り手",
      role: "中学3年生",
      gender: "男性",
      firstPerson: "僕",
      evidence: "僕は中学三年の夏、マンションの屋上で風に吹かれていた",
    },
  ],
};

function baselineOf(characters: Character[]): ExtractionBaseline {
  return { characters, abilities: [], locations: [], organizations: [], world: [] };
}

describe("名前の決められない語り手を「語り手（僕）」にする（検算）", () => {
  test("地の文の一人称と同じ代名詞の名前は、捨てずに語り手として受け入れる", () => {
    const result = validateCharacterExtractResult(NARRATOR_ANSWER, CHUNK);

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    const [accepted] = result.accepted;
    expect(accepted.data.name).toBe("語り手（僕）");
    expect(accepted.data.firstPerson).toBe("僕");
    // 紹介は抽出の案のまま
    expect(accepted.data.summary).toBe("中学3年生の語り手");
    expect(accepted.unnamedNarrator).toEqual({ firstPerson: "僕" });
    // 「僕」を別名に入れない（名前の形として本文を探されないため）
    expect(accepted.data.aliases ?? []).not.toContain("僕");
  });

  test("「俺」の語りなら「語り手（俺）」になる", () => {
    const text = NARRATION.replace(/僕/gu, "俺");
    const result = validateCharacterExtractResult(
      {
        characters: [
          { name: "俺", evidence: "俺は中学三年の夏、マンションの屋上で風に吹かれていた" },
        ],
      },
      chunkOf(text)
    );

    expect(result.accepted.map((item) => item.data.name)).toEqual(["語り手（俺）"]);
  });

  test("「語り手」の名前でも、一人称が地の文と合えば語り手にする", () => {
    const result = validateCharacterExtractResult(
      {
        characters: [
          {
            name: "語り手",
            firstPerson: "僕",
            evidence: "僕は耳を澄ませた",
          },
        ],
      },
      CHUNK
    );

    expect(result.accepted.map((item) => item.data.name)).toEqual(["語り手（僕）"]);
  });

  test("地の文が別の一人称なら、今までどおり捨てる（台詞で名乗る脇役を語り手にしない）", () => {
    const text = NARRATION.replace(/僕/gu, "私") + "「俺は帰る」と少年が言った。\n";
    const result = validateCharacterExtractResult(
      { characters: [{ name: "俺", evidence: "「俺は帰る」と少年が言った" }] },
      chunkOf(text)
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((item) => item.reason)).toEqual(["pronoun_name"]);
  });

  test("二人称・三人称の代名詞は語り手にしない", () => {
    const text = NARRATION + "　あんたは誰だと僕は思った。\n";
    const result = validateCharacterExtractResult(
      { characters: [{ name: "あんた", evidence: "あんたは誰だと僕は思った" }] },
      chunkOf(text)
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((item) => item.reason)).toEqual(["pronoun_name"]);
  });

  test("一人称の分からない「主人公」は、今までどおり捨てる", () => {
    const result = validateCharacterExtractResult(
      { characters: [{ name: "主人公", evidence: "僕は耳を澄ませた" }] },
      CHUNK
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((item) => item.reason)).toEqual(["descriptive_name"]);
  });

  test("既知名として見せた「語り手（僕）」で返ってきても、同じ語り手として受け入れる", () => {
    const result = validateCharacterExtractResult(
      {
        characters: [{ name: "語り手（僕）", evidence: "僕は返事をしなかった" }],
      },
      CHUNK,
      { knownRecordNames: ["語り手（僕）"] }
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.unnamedNarrator).toEqual({ firstPerson: "僕" });
  });

  test("本文に無い引用なら、語り手でも根拠なしで落とす（検算は既存の決まりどおり）", () => {
    const result = validateCharacterExtractResult(
      { characters: [{ name: "僕", evidence: "僕は空を飛んだ" }] },
      CHUNK
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((item) => item.reason)).toEqual(["ungrounded"]);
  });
});

describe("語り手の記録を重ねて作らない（マージ）", () => {
  test("2回抽出しても1件だけ（2回目は既存への更新）", () => {
    const first = replayExtraction({
      chunks: [{ chunk: CHUNK, parsed: NARRATOR_ANSWER }],
      baseline: baselineOf([]),
      initialAbilityTerm: null,
    });
    expect(first.characters.created.map((c) => c.name)).toEqual(["語り手（僕）"]);
    const created = first.characters.created[0];
    expect(created.unnamedNarrator).toEqual({ firstPerson: "僕" });
    expect(created.firstPerson.default).toBe("僕");

    const second = replayExtraction({
      chunks: [{ chunk: CHUNK, parsed: NARRATOR_ANSWER }],
      baseline: baselineOf([created]),
      initialAbilityTerm: null,
    });
    expect(second.characters.created).toEqual([]);
  });

  test("同じ実行で複数の話に出ても1件", () => {
    const result = replayExtraction({
      chunks: [
        { chunk: CHUNK, parsed: NARRATOR_ANSWER },
        { chunk: chunkOf(NARRATION, 2), parsed: NARRATOR_ANSWER },
      ],
      baseline: baselineOf([]),
      initialAbilityTerm: null,
    });

    expect(result.characters.created.map((c) => c.name)).toEqual(["語り手（僕）"]);
    expect(result.characters.created[0].appearedChapters).toEqual([1, 2]);
  });

  test("作者が名前を付けたあとに抽出しても、新しく作らずその人へ寄せる", () => {
    const renamed: Character = {
      ...emptyCharacter("char_001", "佐藤 健"),
      firstPerson: { default: "僕", variants: [] },
      unnamedNarrator: { firstPerson: "僕" },
    };

    const merged = mergeExtractedCharacters(
      [renamed],
      [
        {
          data: { name: "語り手（僕）", firstPerson: "僕", summary: "中学3年生" },
          chapters: [2],
          unnamedNarrator: { firstPerson: "僕" },
        },
      ]
    );

    expect(merged.added).toEqual([]);
    expect(merged.characters).toHaveLength(1);
    const person = merged.characters[0];
    expect(person.name).toBe("佐藤 健");
    // 仮の名前を別名へ足さない
    expect(person.aliases).not.toContain("語り手（僕）");
    expect(person.appearedChapters).toEqual([2]);
  });

  test("作者が確定させた語り手（autoGenerated: false）は話数の追記だけ", () => {
    const confirmed: Character = {
      ...emptyCharacter("char_001", "佐藤 健"),
      firstPerson: { default: "僕", variants: [] },
      unnamedNarrator: { firstPerson: "僕" },
      autoGenerated: false,
      summary: "作者が書いた紹介",
    };

    const merged = mergeExtractedCharacters(
      [confirmed],
      [
        {
          data: { name: "語り手（僕）", firstPerson: "僕", summary: "AIの紹介" },
          chapters: [3],
          unnamedNarrator: { firstPerson: "僕" },
        },
      ]
    );

    expect(merged.characters[0].summary).toBe("作者が書いた紹介");
    expect(merged.characters[0].appearedChapters).toEqual([3]);
  });

  test("同じ一人称の人物が台帳に1人だけいれば、その人を語り手とみて新しく作らない", () => {
    // `detectNarrator` が選ぶのと同じ人。ここで作ると、語り手が2人になって決められなくなる
    const named: Character = {
      ...emptyCharacter("char_001", "相沢 春人"),
      firstPerson: { default: "僕", variants: [] },
    };

    const merged = mergeExtractedCharacters(
      [named],
      [
        {
          data: { name: "語り手（僕）", firstPerson: "僕" },
          chapters: [1],
          unnamedNarrator: { firstPerson: "僕" },
        },
      ]
    );

    expect(merged.added).toEqual([]);
    expect(merged.characters[0].aliases).not.toContain("語り手（僕）");
  });

  test("同じ一人称の人物が2人以上いれば、作らずに報告へ回す", () => {
    const a: Character = {
      ...emptyCharacter("char_001", "相沢 春人"),
      firstPerson: { default: "僕", variants: [] },
    };
    const b: Character = {
      ...emptyCharacter("char_002", "千夏"),
      firstPerson: { default: "僕", variants: [] },
    };

    const merged = mergeExtractedCharacters(
      [a, b],
      [
        {
          data: { name: "語り手（僕）", firstPerson: "僕" },
          chapters: [1],
          unnamedNarrator: { firstPerson: "僕" },
        },
      ]
    );

    expect(merged.added).toEqual([]);
    expect(merged.changedIds).toEqual([]);
    expect(merged.unplacedNarrators).toEqual([
      { firstPerson: "僕", candidates: ["相沢 春人", "千夏"] },
    ]);
  });
});

describe("語り手の記録を、語り手を手がかりにする機能が使える", () => {
  const narrator: Character = {
    ...emptyCharacter("char_003", unnamedNarratorName("僕")),
    firstPerson: { default: "僕", variants: [] },
    unnamedNarrator: { firstPerson: "僕" },
  };
  const others: Character[] = [
    emptyCharacter("char_001", "管理人のおじいさん"),
    emptyCharacter("char_002", "新しい管理人さん"),
  ];
  const longNarration = NARRATION.repeat(4) + "　僕は僕のことを考えた。".repeat(30);

  test("detectNarrator が一人称の欄でこの記録を選ぶ", () => {
    expect(
      detectNarrator({ narrationText: longNarration, people: [...others, narrator] })
    ).toEqual({ firstPerson: "僕", name: "語り手（僕）" });
  });

  test("名前の形を作らない（「僕は」を名前の出現と誤らない）", () => {
    const hint = { firstPerson: "僕", name: "語り手（僕）" };
    expect(narratorNameForms(hint, [...others, narrator])).toEqual([]);

    const found = findNarratorNameSlips({
      text: NARRATION + "　僕は語り手だった。\n",
      narrator: hint,
      people: [...others, narrator],
    });
    expect(found.slips).toEqual([]);
  });

  test("作者が名前を付けたあとは、その名前で探す", () => {
    const renamed = { ...narrator, name: "佐藤 健" };
    expect(
      narratorNameForms({ firstPerson: "僕", name: "佐藤 健" }, [...others, renamed])
    ).toContain("佐藤");
  });
});

describe("完了報告の文面", () => {
  test("作ったものも置けなかったものも無ければ、何も出さない", () => {
    expect(describeUnnamedNarratorOutcome([], [])).toBe("");
  });

  test("作ったことと、名前を付け直せることを言う", () => {
    const text = describeUnnamedNarratorOutcome(["語り手（僕）"], []);
    expect(text).toContain("「語り手（僕）」として登録しました");
    expect(text).toContain("設定資料で付け直せます");
  });

  test("置けなかったときは、同じ一人称の人物を名指しする", () => {
    const text = describeUnnamedNarratorOutcome(
      [],
      [{ firstPerson: "僕", candidates: ["相沢 春人", "千夏"] }]
    );
    expect(text).toContain("相沢 春人・千夏");
    expect(text).toContain("登録しませんでした");
  });
});

describe("印の読み書き", () => {
  test("仮の名前から一人称を読み取る", () => {
    expect(unnamedNarratorName("俺")).toBe("語り手（俺）");
    expect(firstPersonOfUnnamedNarratorName("語り手（俺）")).toBe("俺");
    expect(firstPersonOfUnnamedNarratorName("佐藤 健")).toBeNull();
  });

  test("資料のJSONに印が残り、読み直せる", () => {
    const raw = {
      ...emptyCharacter("char_001", "語り手（僕）"),
      unnamedNarrator: { firstPerson: "僕" },
    };
    expect(parseCharacter(JSON.parse(JSON.stringify(raw))).unnamedNarrator).toEqual({
      firstPerson: "僕",
    });
  });

  test("壊れた印は読み込みエラーにする（黙って捨てると、次の抽出で語り手が重なる）", () => {
    const raw = {
      ...emptyCharacter("char_001", "語り手（僕）"),
      unnamedNarrator: { firstPerson: "" },
    };
    expect(() => parseCharacter(raw)).toThrow();
  });

  test("印の無い人物には欄ごと置かない", () => {
    expect("unnamedNarrator" in parseCharacter(emptyCharacter("char_001", "灯"))).toBe(false);
  });
});
