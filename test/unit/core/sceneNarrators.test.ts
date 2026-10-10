import { describe, expect, test } from "vitest";
import {
  describeSuspectVariant,
  enrichForeignNarratorOf,
  foreignNarrationScenes,
  foreignNarrationScenesInChunk,
  foreignNarratorNoteOf,
  foreignSceneOfEvidence,
  suspectForeignFirstPersonVariants,
  workNarratorContextOf,
  type WorkNarratorContext,
} from "../../../src/core/sceneNarrators";
import { countNarrationFirstPersons } from "../../../src/core/workStyleFacts";
import {
  isMeaningfulValue,
  validateCharacterExtractResult,
} from "../../../src/core/characterExtractionValidation";
import {
  buildCharacterExtractPrompt,
  type CharacterExtractResult,
  type ExtractedCharacter,
} from "../../../src/prompts/characterExtract";
import { buildEnrichPrompt } from "../../../src/prompts/settingsEnrich";
import {
  applyCharacterEdits,
  firstPersonVariantRemoveKey,
  toRecordEdits,
} from "../../../src/core/settingsEdit";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 場面ごとに一人称の語り手が入れ替わる作品（作者の裁定 2026-10-10
 * 「控えめな直しから」。設計書6.5.12）。
 *
 * 作り物は「ハイエルフ未亡人」の形を写す——主人公アジャーノは地の文の「俺」、
 * 区切り「◇◆◇◆」の後の皇子の場面は地の文の「余」。
 */

function person(options: {
  id: string;
  name: string;
  firstPerson?: string | null;
  variants?: Array<{ form: string; chapters?: number[]; evidence?: string | null }>;
  aliases?: string[];
}): Character {
  return {
    ...emptyCharacter(options.id, options.name),
    aliases: options.aliases ?? [],
    firstPerson: {
      default: options.firstPerson ?? null,
      variants: (options.variants ?? []).map((variant) => ({
        form: variant.form,
        context: null,
        chapters: variant.chapters ?? [],
        evidence: variant.evidence ?? null,
      })),
    },
  };
}

const HERO = person({ id: "char_007", name: "アジャーノ", firstPerson: "俺", aliases: ["アジャーノ殿"] });
const EMPEROR = person({ id: "char_012", name: "皇帝", firstPerson: "余" });
const PRINCE = person({ id: "char_016", name: "殿下" });

function contextOf(people: Character[]): WorkNarratorContext {
  return {
    narrator: { firstPerson: "俺", name: "アジャーノ" },
    narratorNames: ["アジャーノ", "アジャーノ殿"],
    people,
  };
}

const HERO_SCENE =
  "　俺は串焼きを頬張った。旨い。\n" +
  "　俺はもう一本頼むことにした。\n" +
  "「おかわりだ」\n";
const PRINCE_SCENE =
  "　広い部屋にポツンと置かれた机で、余は先生の話をただ聞いていた。\n" +
  "「皇子殿下は、どの教科も優秀でございます」\n" +
  "　余もいつか、この退屈な皇宮から出ることができるのだろうか。\n";
const MIXED = `${HERO_SCENE}\n◇◆◇◆\n\n${PRINCE_SCENE}`;

function chunkOf(text: string, chapter = 12): Chunk {
  return {
    filePath: `本文/${chapter}_話.txt`,
    index: 0,
    text,
    startLine: 0,
    hash: `h${chapter}`,
    chapterStart: chapter,
    chapterEnd: chapter,
  };
}

describe("「余」を一人称として数える", () => {
  test("助詞の続く「余は」「余も」は数え、熟語の「余」は数えない", () => {
    const counts = countNarrationFirstPersons(
      "　余は先生の話を聞いた。余もいつか出たい。\n　紆余曲折の末、余韻に浸り、余計なことを言い、余裕がある。十余の兵。\n"
    );
    expect(counts.get("余")).toBe(2);
  });
});

describe("主人公でない語り手の場面を見分ける", () => {
  test("区切りの後の「余」の場面だけを返す", () => {
    const scenes = foreignNarrationScenes(MIXED, "俺");
    expect(scenes).toHaveLength(1);
    expect(scenes[0].firstPerson).toBe("余");
    expect(MIXED.slice(scenes[0].start, scenes[0].end)).toContain("余は先生の話");
    expect(MIXED.slice(scenes[0].start, scenes[0].end)).not.toContain("◇◆◇◆");
  });

  test("「余」が1回だけの場面・主人公の一人称が多い場面・一人称の無い場面は返さない", () => {
    const once = "　余は窓の外を見た。\n　空が青い。\n";
    const heroMostly =
      "　俺は走った。俺は跳んだ。俺は叫んだ。俺は笑った。俺は泣いた。\n　余は、と言いかけた。余の字を思い出した。\n";
    const none = "　皇帝は玉座に座っていた。\n　宰相が頭を下げた。\n";
    for (const text of [once, heroMostly, none, HERO_SCENE]) {
      expect(foreignNarrationScenes(text, "俺")).toEqual([]);
    }
  });

  test("「自分」が多いだけの主人公の場面・「自分で」しか無い場面は返さない（実データの第6話）", () => {
    const sixth = "　自分で焼いた串を、自分の皿に載せる。\n　俺はそれを頬張った。\n";
    const reflexive = "　自分で焼いた串を、自分の皿に載せる。\n　旨い。\n";
    expect(foreignNarrationScenes(sixth, "俺")).toEqual([]);
    expect(foreignNarrationScenes(reflexive, "俺")).toEqual([]);
  });

  test("まとめたチャンクでは話の境でも場面を割る", () => {
    const first = PRINCE_SCENE;
    const second = HERO_SCENE.repeat(2);
    const chunk: Chunk = {
      ...chunkOf(`${first}${second}`, 11),
      chapterEnd: 12,
      segments: [
        { filePath: "a", chapterStart: 11, chapterEnd: 11, start: 0, end: first.length, startLine: 0 },
        {
          filePath: "b",
          chapterStart: 12,
          chapterEnd: 12,
          start: first.length,
          end: first.length + second.length,
          startLine: 0,
        },
      ],
    };
    const scenes = foreignNarrationScenesInChunk(chunk, "俺");
    expect(scenes).toHaveLength(1);
    expect(scenes[0].end).toBeLessThanOrEqual(first.length);
  });

  test("引用が主人公でない場面にだけあるときだけ、その場面を返す", () => {
    const scenes = foreignNarrationScenes(MIXED, "俺");
    expect(foreignSceneOfEvidence(MIXED, scenes, "皇子殿下は、どの教科も優秀でございます")).not.toBeNull();
    expect(foreignSceneOfEvidence(MIXED, scenes, "俺はもう一本頼むことにした")).toBeNull();
    expect(foreignSceneOfEvidence(MIXED, scenes, "本文に無い引用です")).toBeNull();
  });
});

describe("断り書きの名指し", () => {
  const scenes = [{ firstPerson: "余" }];

  test("持ち主が主人公以外の1人で、その場面の本文に出ていれば名指しする", () => {
    const note = foreignNarratorNoteOf(
      [{ firstPerson: "余", text: "　余は皇帝として玉座に座った。余は退屈だった。\n" }],
      contextOf([HERO, EMPEROR, PRINCE])
    );
    expect(note?.forms).toEqual([{ firstPerson: "余", speaker: "皇帝" }]);
  });

  test("持ち主が1人でも、その場面の本文に出ていなければ名指ししない（0.102.2）", () => {
    // 本文の渡らない形（0.102.1 まではこれで名指ししていた）
    expect(foreignNarratorNoteOf(scenes, contextOf([HERO, EMPEROR, PRINCE]))?.forms).toEqual([
      { firstPerson: "余", speaker: null },
    ]);
    const note = foreignNarratorNoteOf(
      [{ firstPerson: "余", text: PRINCE_SCENE }],
      contextOf([HERO, EMPEROR, PRINCE])
    );
    expect(note?.forms).toEqual([{ firstPerson: "余", speaker: null }]);
  });

  test("持ち主が2人なら名指ししない（取り違えの言い分けを持つ主人公も数える）", () => {
    const polluted = person({
      id: "char_007",
      name: "アジャーノ",
      firstPerson: "俺",
      variants: [{ form: "余", chapters: [12] }],
    });
    const note = foreignNarratorNoteOf(scenes, contextOf([polluted, EMPEROR]));
    expect(note?.forms).toEqual([{ firstPerson: "余", speaker: null }]);
  });

  test("持ち主が主人公だけなら名指ししない", () => {
    const polluted = person({
      id: "char_007",
      name: "アジャーノ",
      firstPerson: "俺",
      variants: [{ form: "余", chapters: [12] }],
    });
    const note = foreignNarratorNoteOf(scenes, contextOf([polluted, PRINCE]));
    expect(note?.forms).toEqual([{ firstPerson: "余", speaker: null }]);
  });

  test("場面が無ければ断り書きは無い", () => {
    expect(foreignNarratorNoteOf([], contextOf([HERO]))).toBeNull();
  });
});

describe("抽出の頼み方（P-04a 5.10）", () => {
  const base = { chunkText: MIXED, chapterLabel: "第12話", knownCharacterNames: ["アジャーノ"] };

  test("主人公でない語り手の場面があれば断り書きが入る", () => {
    const note = foreignNarratorNoteOf([{ firstPerson: "余" }], contextOf([HERO, EMPEROR, PRINCE, person({ id: "x", name: "老臣", firstPerson: "余" })]));
    const prompt = buildCharacterExtractPrompt({ ...base, foreignNarrator: note });
    expect(prompt).toContain("【地の文の語り手についての注意】");
    expect(prompt).toContain(
      "地の文が一人称「余」で語られている場面の語り手は、アジャーノ（地の文の一人称「俺」）ではありません。"
    );
    expect(prompt).toContain("「余」の行動・考え・一人称を、アジャーノの資料に付けないでください。");
    // 持ち主が2人（皇帝・老臣）なので名指ししない
    expect(prompt).not.toContain("その場面の語り手は");
  });

  test("場面が無ければ 5.9 と同じ文（断り書きの節が無い）", () => {
    expect(buildCharacterExtractPrompt({ ...base, foreignNarrator: null })).toBe(
      buildCharacterExtractPrompt(base)
    );
    expect(buildCharacterExtractPrompt(base)).not.toContain("語り手についての注意");
  });

  test("断り書きの言葉が値として返ってきたら、中身の無い値として落とす", () => {
    expect(isMeaningfulValue("地の文の語り手はアジャーノではありません")).toBe(false);
    expect(isMeaningfulValue("皇子。アジャーノの資料に付けないでください")).toBe(false);
    expect(isMeaningfulValue("物語の語り手役を務める吟遊詩人")).toBe(true);
    // 世界観・作品の説明として正しい値は落とさない
    expect(isMeaningfulValue("一人称の語り。地の文の語り手が場面ごとに替わる")).toBe(true);
    expect(isMeaningfulValue("地の文の語り手は宮廷の書記官で、物語を後から書き留めている")).toBe(true);
  });
});

function answerOf(character: Partial<ExtractedCharacter>): CharacterExtractResult {
  return {
    characters: [
      {
        name: "アジャーノ",
        entityType: "person",
        summary: "皇子",
        role: "皇子",
        relations: [],
        ...character,
      } as ExtractedCharacter,
    ],
  };
}

describe("抽出の検算（主人公でない語り手の場面）", () => {
  const options = {
    knownRecordNames: ["アジャーノ"],
    workNarrator: contextOf([HERO, EMPEROR, PRINCE]),
  };

  test("根拠がその場面にだけある主人公の答えは落とす（foreign_narrator_scene）", () => {
    const result = validateCharacterExtractResult(
      answerOf({ evidence: "皇子殿下は、どの教科も優秀でございます", firstPerson: "余" }),
      chunkOf(MIXED),
      options
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toEqual([{ name: "アジャーノ", reason: "foreign_narrator_scene" }]);
  });

  test("根拠が主人公の場面でも、その場面の一人称は一人称の欄だけ外す", () => {
    const result = validateCharacterExtractResult(
      answerOf({ evidence: "俺はもう一本頼むことにした", firstPerson: "余" }),
      chunkOf(MIXED),
      options
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.firstPerson).toBeUndefined();
    expect(result.droppedFirstPersons).toEqual([
      { characterName: "アジャーノ", firstPerson: "余", reason: "foreign_narrator_first_person" },
    ]);
  });

  test("根拠が同じ話の一人称の無い場面にあり、一人称がその場面の形なら記録ごと落とす（実データの第12話の形）", () => {
    const twelfth = `${PRINCE_SCENE}\n◇◆◇◆\n\n　執務室で若い皇帝に声をかけたのは、宰相の側近だった。\n「はい、皇子殿下は、どの教科も優秀でございます」\n`;
    const result = validateCharacterExtractResult(
      answerOf({ evidence: "はい、皇子殿下は、どの教科も優秀でございます", firstPerson: "余" }),
      chunkOf(twelfth),
      options
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toEqual([{ name: "アジャーノ", reason: "foreign_narrator_scene" }]);
  });

  test("主人公でない人物の答えは今までどおり", () => {
    const result = validateCharacterExtractResult(
      answerOf({ name: "殿下", evidence: "皇子殿下は、どの教科も優秀でございます", firstPerson: "余" }),
      chunkOf(MIXED),
      { ...options, knownRecordNames: ["殿下"] }
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.firstPerson).toBe("余");
  });

  test("主人公でない場面の無いチャンク・語り手を渡さない呼び出しは今までどおり", () => {
    const heroOnly = validateCharacterExtractResult(
      answerOf({ evidence: "俺はもう一本頼むことにした", firstPerson: "俺" }),
      chunkOf(HERO_SCENE, 1),
      options
    );
    expect(heroOnly.accepted).toHaveLength(1);
    expect(heroOnly.droppedFirstPersons).toEqual([]);

    const withoutNarrator = validateCharacterExtractResult(
      answerOf({ evidence: "皇子殿下は、どの教科も優秀でございます", firstPerson: "余" }),
      chunkOf(MIXED),
      { knownRecordNames: ["アジャーノ"] }
    );
    expect(withoutNarrator.accepted).toHaveLength(1);
    expect(withoutNarrator.accepted[0].data.firstPerson).toBe("余");
  });
});

describe("作品の語り手", () => {
  test("全話の地の文の一人称が人物1人に結び付けば、その人の名前と別名を持つ", () => {
    const work = Array.from({ length: 14 }, (_, index) => `　俺は今日も働いた。${index}日目の仕事は荷運びで、腰が痛くなるほどの量だった。\n`).join("");
    const context = workNarratorContextOf(`${work}\n◇◆◇◆\n${PRINCE_SCENE}`, [HERO, EMPEROR, PRINCE]);
    expect(context?.narrator).toEqual({ firstPerson: "俺", name: "アジャーノ" });
    expect(context?.narratorNames).toEqual(["アジャーノ", "アジャーノ殿"]);
  });
});

describe("再読込（P-20 2.2）", () => {
  const sources = [
    { label: "第1話", text: HERO_SCENE, chapter: 1 },
    { label: "第12話", text: MIXED, chapter: 12 },
  ];

  test("対象が主人公で、抜粋にほかの語り手の場面が入れば、その抜粋の頭に断り書きを置く", () => {
    const excerpts = [
      { label: "第1話", text: HERO_SCENE.trim() },
      { label: "第12話", text: MIXED.trim() },
    ];
    const foreign = enrichForeignNarratorOf(HERO, excerpts, sources, contextOf([HERO, EMPEROR, PRINCE]));
    expect(foreign?.excerptForms).toEqual([[], ["余"]]);
    const prompt = buildEnrichPrompt({
      workTitle: "作品",
      kind: "character",
      target: { kindLabel: "登場人物", name: "アジャーノ", currentSettings: "" },
      excerpts,
      foreignNarrator: foreign,
    });
    expect(prompt).toContain(
      "--- 第12話 ---\n［注意：この抜粋には、地の文の語り手がアジャーノでない場面があります。地の文が一人称「余」で語られている場面の語り手は、アジャーノ（地の文の一人称「俺」）ではありません。"
    );
    expect(prompt).toContain(`--- 第1話 ---\n${HERO_SCENE.trim()}`);
  });

  test("対象が主人公でなければ断り書きは無い（頼み方は 2.1 と同じ）", () => {
    const excerpts = [{ label: "第12話", text: MIXED.trim() }];
    expect(enrichForeignNarratorOf(EMPEROR, excerpts, sources, contextOf([HERO, EMPEROR]))).toBeNull();
    const input = {
      workTitle: "作品",
      kind: "character" as const,
      target: { kindLabel: "登場人物", name: "皇帝", currentSettings: "" },
      excerpts,
    };
    expect(buildEnrichPrompt({ ...input, foreignNarrator: null })).toBe(buildEnrichPrompt(input));
  });
});

describe("既に混ざった一人称の言い分け（裁定4）", () => {
  const sources = [
    { label: "第1話", text: HERO_SCENE, chapter: 1 },
    { label: "第12話", text: MIXED, chapter: 12 },
  ];
  const polluted = person({
    id: "char_007",
    name: "アジャーノ",
    firstPerson: "俺",
    aliases: ["アジャーノ殿"],
    variants: [
      { form: "余", chapters: [12], evidence: "皇子殿下は、どの教科も優秀でございます" },
      { form: "僕", chapters: [1], evidence: null },
    ],
  });

  test("ほかの語り手の場面の一人称だけを、外す案にする", () => {
    const suspects = suspectForeignFirstPersonVariants(polluted, contextOf([polluted, EMPEROR]), sources);
    expect(suspects.map((suspect) => suspect.variant.form)).toEqual(["余"]);
    expect(suspects[0].chapters).toEqual([12]);
    expect(describeSuspectVariant(suspects[0]).before).toBe(
      "余（第12話） 根拠「皇子殿下は、どの教科も優秀でございます」"
    );
  });

  test("根拠が同じ話の一人称の無い場面（皇帝と側近の場面）にあっても疑う（実データの第12話）", () => {
    const twelfth = `${PRINCE_SCENE}\n◇◆◇◆\n\n　執務室で若い皇帝に声をかけたのは、宰相の側近だった。\n「はい、皇子殿下は、どの教科も優秀でございます」\n`;
    const suspects = suspectForeignFirstPersonVariants(polluted, contextOf([polluted, EMPEROR]), [
      { label: "第12話", text: twelfth, chapter: 12 },
    ]);
    expect(suspects.map((suspect) => suspect.variant.form)).toEqual(["余"]);
  });

  test("根拠が主人公の場面にあれば疑わない（主人公が本当に言い分けた所かもしれない）", () => {
    const own = person({
      id: "char_007",
      name: "アジャーノ",
      firstPerson: "俺",
      variants: [{ form: "余", chapters: [12], evidence: "俺はもう一本頼むことにした" }],
    });
    expect(suspectForeignFirstPersonVariants(own, contextOf([own]), sources)).toEqual([]);
  });

  test("主人公でない人物の言い分けは見ない", () => {
    const emperor = person({ id: "char_012", name: "皇帝", firstPerson: "朕", variants: [{ form: "余", chapters: [12] }] });
    expect(suspectForeignFirstPersonVariants(emperor, contextOf([HERO, emperor]), sources)).toEqual([]);
  });

  test("作者が選んだときだけ、形と話数が同じ言い分けを外す（ほかの言い分けは残る）", () => {
    const key = firstPersonVariantRemoveKey({ form: "余", chapters: [12] });
    const edited = applyCharacterEdits(polluted, toRecordEdits({ [key]: "外す" }), {
      authorConfirmed: false,
    });
    expect(edited.firstPerson.variants.map((variant) => variant.form)).toEqual(["僕"]);
    expect(edited.firstPerson.default).toBe("俺");
    // 選ばなければ触らない
    expect(applyCharacterEdits(polluted, toRecordEdits({}), { authorConfirmed: false }).firstPerson).toEqual(
      polluted.firstPerson
    );
  });
});
