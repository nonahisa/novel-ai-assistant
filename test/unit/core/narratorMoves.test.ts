import { describe, expect, test } from "vitest";
import {
  applyNarratorMoves,
  describeNarratorMove,
  findNarratorMoves,
  foreignOnlyChapters,
  type NarratorMoveItem,
} from "../../../src/core/narratorMoves";
import {
  foreignNarrationScenes,
  foreignNarratorNoteOf,
  withSceneText,
  type WorkNarratorContext,
} from "../../../src/core/sceneNarrators";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { RecordChange } from "../../../src/models/jsonValidation";

/**
 * 語り手の取り違えで主人公の資料に入った値を、本来の人物の資料へ移す案
 * （作者の裁定 2026-10-10「殿下の資料へ移す案」。設計書6.5.12）。
 *
 * 作り物は「ハイエルフ未亡人」の形を写す——主人公アジャーノは地の文の「俺」、
 * 第12話の前半は皇子の場面（地の文「余」）、後半は皇帝と側近の三人称の場面。
 */

const HERO_SCENE =
  "　俺は串焼きを頬張った。旨い。\n" +
  "　俺はもう一本頼むことにした。\n" +
  "「おかわりだ」\n";
const PRINCE_SCENE =
  "　広い部屋にポツンと置かれた机で、余は先生の話をただ聞いていた。\n" +
  "「これは経済の基本です。殿下、聞いていますか」\n" +
  "　余もいつか、この退屈な皇宮から出ることができるのだろうか。\n";
const EMPEROR_SCENE =
  "「陛下、ご報告に参りました」\n" +
  "　執務室で若い皇帝に声をかけたのは、宰相の側近だった。\n" +
  "「はい、皇子殿下は、どの教科も優秀でございます」\n";
const TWELFTH = `${PRINCE_SCENE}\n◇◆◇◆\n\n${EMPEROR_SCENE}`;

const SOURCES = [
  { label: "第10話", text: HERO_SCENE, chapter: 10 },
  { label: "第12話", text: TWELFTH, chapter: 12 },
];

function change(field: string, value: string, chapters: number[]): RecordChange {
  return {
    field,
    value,
    chapters,
    timepointId: null,
    note: null,
    evidence: null,
    source: "extracted",
  };
}

function hero(overrides: Partial<Character> = {}): Character {
  return {
    ...emptyCharacter("char_007", "アジャーノ"),
    aliases: ["アジャーノ殿"],
    affiliation: "皇室",
    role: "冒険者",
    firstPerson: {
      default: "俺",
      variants: [
        {
          form: "余",
          context: null,
          chapters: [12],
          evidence: "皇子殿下は、どの教科も優秀でございます",
        },
      ],
    },
    changes: [
      change("affiliation", "冒険者ギルド", [10]),
      change("affiliation", "皇室", [12]),
      change("role", "皇子", [12]),
      change("role", "冒険者", [10]),
      // 主人公の場面のある話も含む値は対象外
      change("gender", "男性", [10, 12]),
    ],
    relations: [
      { name: "エルシー", relation: "雇用主" },
      // 話数の無い古い関係（相手の登場話との重なりで見る）
      { name: "皇帝", relation: "子" },
    ],
    addressTerms: [
      {
        targetName: "アジャーノ",
        targetId: null,
        authorLocked: false,
        forms: [
          {
            term: "殿下",
            category: "defaultSecondPerson",
            context: null,
            firstChapter: 12,
            lastChapter: 12,
            status: "current",
            evidence: "「殿下、聞いていますか」",
          },
          {
            term: "あなた",
            category: "defaultSecondPerson",
            context: null,
            firstChapter: 10,
            lastChapter: 12,
            status: "current",
            evidence: null,
          },
        ],
      },
    ],
    personalityFacets: [
      { value: "知的好奇心が強い", chapters: [12], evidence: null },
      { value: "慎重", chapters: [10], evidence: null },
    ],
    personality: "知的好奇心が強い／慎重",
    appearedChapters: [10, 12],
    ...overrides,
  };
}

const EMPEROR: Character = {
  ...emptyCharacter("char_012", "皇帝"),
  aliases: ["陛下"],
  firstPerson: { default: "余", variants: [] },
  appearedChapters: [11, 12],
};
const PRINCE: Character = emptyCharacter("char_016", "殿下");
const ELSIE: Character = { ...emptyCharacter("char_005", "エルシー"), appearedChapters: [10] };

function contextOf(people: Character[]): WorkNarratorContext {
  return {
    narrator: { firstPerson: "俺", name: "アジャーノ" },
    narratorNames: ["アジャーノ", "アジャーノ殿"],
    people,
  };
}

function kinds(items: NarratorMoveItem[]): string[] {
  return items.map((item) => `${item.kind}:${item.value}`);
}

describe("ほかの語り手の場面だけの話", () => {
  test("主人公でない語り手の場面があり、主人公の一人称も名前も無い話だけ", () => {
    const chapters = foreignOnlyChapters(SOURCES, contextOf([hero(), EMPEROR, PRINCE]));
    expect([...chapters.keys()]).toEqual([12]);
    expect(chapters.get(12)?.scenes.map((scene) => scene.firstPerson)).toEqual(["余"]);
  });

  test("主人公の名前が出る話は疑わない（三人称の場面に主人公が居るのかもしれない）", () => {
    const named = [
      { label: "第12話", text: `${TWELFTH}　皇帝はアジャーノの噂を聞いた。\n`, chapter: 12 },
    ];
    expect(foreignOnlyChapters(named, contextOf([hero(), EMPEROR])).size).toBe(0);
  });
});

describe("移す案を見つける", () => {
  test("話数がほかの語り手の場面だけの値を、項目ごとに見つける", () => {
    const items = findNarratorMoves(hero(), contextOf([hero(), EMPEROR, PRINCE, ELSIE]), SOURCES);
    expect(kinds(items)).toEqual([
      "change:皇室",
      "change:皇子",
      "personalityFacet:知的好奇心が強い",
      "relation:皇帝=子",
      "address:殿下（相手：アジャーノ）",
      "firstPersonVariant:余",
      "appearedChapters:第12話",
    ]);
    expect(items.every((item) => item.chapters.join() === "12")).toBe(true);
  });

  test("主人公の場面のある話も指す値は対象外（性別 第10・12話・呼称「あなた」第10〜12話）", () => {
    const items = findNarratorMoves(hero(), contextOf([hero(), EMPEROR, PRINCE, ELSIE]), SOURCES);
    expect(kinds(items)).not.toContain("change:男性");
    expect(kinds(items).some((entry) => entry.startsWith("address:あなた"))).toBe(false);
    expect(kinds(items)).not.toContain("relation:エルシー=雇用主");
  });

  test("作者が書いた・認めた変化の記録と、作者が固定した呼称は動かさない", () => {
    const record = hero({
      changes: [
        { ...change("role", "皇子", [12]), source: "author" },
        { ...change("affiliation", "皇室", [12]), confirmed: true },
      ],
      addressTerms: hero().addressTerms.map((term) => ({ ...term, authorLocked: true })),
    });
    const items = findNarratorMoves(record, contextOf([record, EMPEROR, PRINCE]), SOURCES);
    expect(items.some((item) => item.kind === "change" || item.kind === "address")).toBe(false);
  });

  test("主人公でない記録には出さない", () => {
    expect(findNarratorMoves(EMPEROR, contextOf([hero(), EMPEROR]), SOURCES)).toEqual([]);
  });
});

describe("移し先", () => {
  test("その場面の語り手を名指しできれば、その人を移し先に決める", () => {
    const prince = { ...PRINCE, firstPerson: { default: "余", variants: [] } };
    const items = findNarratorMoves(hero(), contextOf([hero(), EMPEROR, prince]), SOURCES);
    expect(items[0].destination).toEqual({
      kind: "named",
      id: "char_016",
      name: "殿下",
      candidates: [{ id: "char_016", name: "殿下" }],
    });
    expect(describeNarratorMove(items[0]).reason).toContain("移し先は、その場面の語り手の「殿下」です。");
  });

  test("名指しできなければ、その場面に名前の出る人物から選ばせる（皇帝は後半の場面にしか出ない）", () => {
    const items = findNarratorMoves(hero(), contextOf([hero(), EMPEROR, PRINCE]), SOURCES);
    expect(items[0].destination).toEqual({
      kind: "choose",
      candidates: [{ id: "char_016", name: "殿下" }],
    });
    expect(describeNarratorMove(items[1])).toEqual({
      label: "移す案：役割「皇子」（第12話）",
      before: "皇子（第12話）",
      reason:
        "第12話は、地の文が「余」で語られる、ほかの語り手の場面だけの話です。語り手の取り違えで入った疑いがあります。" +
        "その場面の語り手を決められなかったので、移し先を選んでください（選ばなければ外すだけです）。",
    });
  });
});

describe("承認したときだけ動く", () => {
  const people = [hero(), EMPEROR, PRINCE, ELSIE];
  const items = findNarratorMoves(hero(), contextOf(people), SOURCES);
  const now = "2026-10-10T00:00:00.000Z";

  test("何も選ばなければ、主人公も移し先も変わらない", () => {
    const outcome = applyNarratorMoves(hero(), people, [], now);
    expect(outcome.source).toEqual(hero());
    expect(outcome.destinations).toEqual([]);
  });

  test("選んだ値を主人公から外し、移し先へ足す。外した値は退けた記録へ残す", () => {
    const outcome = applyNarratorMoves(
      hero(),
      people,
      items.map((item) => ({ item, destinationId: "char_016" })),
      now
    );
    expect(outcome.moved).toBe(items.length);
    expect(outcome.missing).toBe(0);

    const source = outcome.source;
    // 本体は残った変化のいちばん後ろの話の値へ戻る
    expect(source.affiliation).toBe("冒険者ギルド");
    expect(source.role).toBe("冒険者");
    expect(source.personality).toBe("慎重");
    expect(source.changes.map((entry) => entry.value)).toEqual(["冒険者ギルド", "冒険者", "男性"]);
    expect(source.relations).toEqual([{ name: "エルシー", relation: "雇用主" }]);
    expect(source.addressTerms[0].forms.map((form) => form.term)).toEqual(["あなた"]);
    expect(source.firstPerson.variants).toEqual([]);
    expect(source.appearedChapters).toEqual([10]);
    expect(source.rejectedValues?.map((entry) => `${entry.field}:${entry.value}`)).toEqual([
      "affiliation:皇室",
      "role:皇子",
      "personality:知的好奇心が強い",
    ]);
    expect(source.rejectedRelations.map((entry) => `${entry.target}=${entry.relation}`)).toEqual([
      "皇帝=子",
    ]);

    const prince = outcome.destinations.find((entry) => entry.id === "char_016");
    expect(prince?.affiliation).toBe("皇室");
    expect(prince?.role).toBe("皇子");
    expect(prince?.personality).toBe("知的好奇心が強い");
    expect(prince?.relations).toEqual([{ name: "皇帝", relation: "子" }]);
    // 主人公自身を指す呼称は、移し先自身へ付け替える
    expect(prince?.addressTerms).toEqual([
      expect.objectContaining({ targetName: "殿下", targetId: "char_016" }),
    ]);
    expect(prince?.firstPerson.default).toBe("余");
    expect(prince?.appearedChapters).toEqual([12]);
  });

  test("移し先を選ばなければ外すだけ（どこにも足さない）", () => {
    const role = items.find((item) => item.value === "皇子");
    if (!role) throw new Error("役割の案が無い");
    const outcome = applyNarratorMoves(hero(), people, [{ item: role, destinationId: null }], now);
    expect(outcome.removedOnly).toBe(1);
    expect(outcome.destinations).toEqual([]);
    expect(outcome.source.changes.some((entry) => entry.value === "皇子")).toBe(false);
  });

  test("いまの資料に無くなっていれば数えて飛ばす（別の窓で直された）", () => {
    const role = items.find((item) => item.value === "皇子");
    if (!role) throw new Error("役割の案が無い");
    const edited = hero({ changes: [] });
    const outcome = applyNarratorMoves(edited, people, [{ item: role, destinationId: "char_016" }], now);
    expect(outcome.missing).toBe(1);
    expect(outcome.destinations).toEqual([]);
  });
});

describe("移し先の作者の値を上書きしない", () => {
  const now = "2026-10-10T00:00:00.000Z";

  test("移し先の本体に値があれば、本体は変えずに変化の記録へ残す", () => {
    const prince: Character = {
      ...PRINCE,
      autoGenerated: false,
      affiliation: "近衛",
      personality: "穏やか",
    };
    const people = [hero(), EMPEROR, prince];
    const items = findNarratorMoves(hero(), contextOf(people), SOURCES);
    const outcome = applyNarratorMoves(
      hero(),
      people,
      items.map((item) => ({ item, destinationId: "char_016" })),
      now
    );
    const moved = outcome.destinations[0];
    expect(moved.affiliation).toBe("近衛");
    expect(moved.personality).toBe("穏やか");
    expect(moved.changes.map((entry) => `${entry.field}:${entry.value}`)).toContain("affiliation:皇室");
    expect(moved.personalityFacets.map((facet) => facet.value)).toContain("知的好奇心が強い");
    expect(outcome.notes.join("\n")).toContain("「殿下」の所属には既に「近衛」があるので");
  });

  test("移し先が固定した呼称には足さない", () => {
    const prince: Character = {
      ...PRINCE,
      addressTerms: [{ targetName: "殿下", targetId: "char_016", authorLocked: true, forms: [] }],
    };
    const people = [hero(), EMPEROR, prince];
    const items = findNarratorMoves(hero(), contextOf(people), SOURCES).filter(
      (item) => item.kind === "address"
    );
    const outcome = applyNarratorMoves(
      hero(),
      people,
      items.map((item) => ({ item, destinationId: "char_016" })),
      now
    );
    expect(outcome.destinations[0].addressTerms[0].forms).toEqual([]);
    expect(outcome.notes.join("\n")).toContain("作者が固定している");
  });
});

describe("断り書きの名指し（0.102.1 の懸念2）", () => {
  const scenes = withSceneText(TWELFTH, foreignNarrationScenes(TWELFTH, "俺"));

  test("主人公から「余」を外して持ち主が皇帝1人になっても、皇帝が場面に出なければ名指ししない", () => {
    const cleaned = hero({ firstPerson: { default: "俺", variants: [] } });
    const note = foreignNarratorNoteOf(scenes, contextOf([cleaned, EMPEROR, PRINCE]));
    expect(note?.forms).toEqual([{ firstPerson: "余", speaker: null }]);
  });

  test("「余」を殿下へ移したあとは、場面に名前の出る殿下を名指しする", () => {
    const cleaned = hero({ firstPerson: { default: "俺", variants: [] } });
    const prince = { ...PRINCE, firstPerson: { default: "余", variants: [] } };
    const note = foreignNarratorNoteOf(scenes, contextOf([cleaned, EMPEROR, prince]));
    expect(note?.forms).toEqual([{ firstPerson: "余", speaker: "殿下" }]);
  });

  test("場面の本文が渡らなければ名指ししない", () => {
    const prince = { ...PRINCE, firstPerson: { default: "余", variants: [] } };
    const note = foreignNarratorNoteOf([{ firstPerson: "余" }], contextOf([hero(), prince]));
    expect(note?.forms).toEqual([{ firstPerson: "余", speaker: null }]);
  });
});
