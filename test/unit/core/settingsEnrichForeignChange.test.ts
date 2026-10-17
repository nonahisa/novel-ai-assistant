import { describe, expect, test } from "vitest";
import { checkEnrichProposals } from "../../../src/core/settingsEnrichCheck";
import type { ExcerptSource } from "../../../src/core/mentionExcerpts";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { RecordChange } from "../../../src/models/jsonValidation";

/**
 * AIで再読込で、別人の記述が混ざった変化の記録を根拠にした案を弾く
 * （作者の裁定 2026-10-17「製品で弾く」。測定 A27・6548）。
 *
 * 台E（ハイエルフ未亡人）のアジャーノの記録には、第12話の抽出で入った
 * 「帝国の皇子」「皇室」が変化として残っている。**第12話の本文に「アジャーノ」の
 * 文字は無い**（皇子は「殿下」「皇子殿下」とだけ呼ばれる）。26b・31b はこれを根拠に
 * 「第12話から皇子」と紹介へ書いた（4回中4回）。
 */

function change(field: string, value: string, chapters: number[], source = "extracted"): RecordChange {
  return {
    field,
    value,
    chapters,
    timepointId: null,
    note: null,
    evidence: null,
    source,
  } as RecordChange;
}

function ajano(): Character {
  const character = emptyCharacter("char_007", "アジャーノ");
  character.aliases = ["アジャーノ様", "アジャーノさん", "アジャーノ殿"];
  character.summary = "オーク肉を『不死妃の宮』へ納品しに来た人物。";
  // 記録の登場話には12が入っている（記録は信用しない。本文で見る）
  character.appearedChapters = [5, 10, 12, 15];
  character.changes = [
    change("role", "B級冒険者", [10]),
    change("summary", "帝国の皇子。学業優秀で経済的な見識を持つが、退屈な皇宮生活に飽き飽きしている。", [12]),
    change("affiliation", "皇室", [12]),
    change("role", "皇子", [12]),
    change("role", "納品人", [15]),
  ];
  return character;
}

const SOURCES: ExcerptSource[] = [
  { label: "第10話", chapter: 10, text: "　アジャーノは槍を構え直した。\n「俺じゃ相手にもならなかったわけだが」" },
  {
    label: "第12話",
    chapter: 12,
    text: "「皇子殿下は、どの教科も優秀でございます」\n　余もいつか、この退屈な皇宮から出ることができるのだろうか。",
  },
  { label: "第15話", chapter: 15, text: "「アジャーノ殿、オーク肉の納品ですね」" },
];

function check(parsed: Record<string, unknown>, record = ajano(), sources: ExcerptSource[] | null = SOURCES) {
  return checkEnrichProposals({
    kind: "character",
    record,
    customFields: [],
    parsed,
    excerptText: SOURCES.filter((source) => source.chapter !== 12)
      .map((source) => source.text)
      .join("\n"),
    knownChapters: new Set([10, 12, 15]),
    sources: sources ?? undefined,
  });
}

describe("名前の出ない話の変化を根拠にした案", () => {
  test("26b の紹介「第12話から皇子」・役割「冒険者、皇子、納品人」・所属「皇室」を弾く", () => {
    const result = check({
      summary: "B級冒険者から第15話で納品人へ。第12話から皇子",
      role: "冒険者、皇子、納品人",
      affiliation: "皇室",
      personality: "慎重で現実的（魔物との接近戦は怖いと正直に語る）",
    });
    const keys = result.proposals.map((item) => item.field.key);
    expect(keys).toEqual(["personality"]);
    expect(result.foreignChanges.map((item) => item.label)).toEqual(["紹介", "所属", "役割"]);
    expect(result.foreignChanges[0]).toMatchObject({ phrases: ["皇子"], chapters: [12] });
  });

  test("31b の紹介「第12話から帝国の皇子となり…」も弾く", () => {
    const result = check({
      summary: "B級の冒険者。第12話から帝国の皇子となり、第15話では『不死妃の宮』へオーク肉を納品している。",
    });
    expect(result.proposals).toHaveLength(0);
    expect(result.foreignChanges[0].phrases).toContain("帝国の皇子");
  });

  test("名前の出る話の変化（第15話の納品人）は弾かない", () => {
    const result = check({ summary: "B級冒険者。第15話から納品人。" });
    expect(result.proposals).toHaveLength(1);
    expect(result.foreignChanges).toEqual([]);
  });

  test("作者が記録した変化は、名前の出ない話でも信じる", () => {
    const record = ajano();
    record.changes = [change("role", "皇子", [12], "author")];
    expect(check({ role: "皇子" }, record).proposals).toHaveLength(1);
  });

  test("その話の本文が手元に無ければ判定しない（通す）", () => {
    const sources = SOURCES.filter((source) => source.chapter !== 12);
    expect(check({ role: "皇子" }, ajano(), sources).proposals).toHaveLength(1);
    // 本文そのものを渡さない呼び出しも、今までどおり
    expect(check({ role: "皇子" }, ajano(), null).proposals).toHaveLength(1);
  });

  test("名前の出る話の変化にも同じ語があれば、その語では弾かない", () => {
    const record = ajano();
    record.changes = [change("role", "冒険者", [12]), change("role", "冒険者", [10])];
    expect(check({ role: "冒険者" }, record).proposals).toHaveLength(1);
  });
});
