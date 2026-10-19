import { describe, expect, test } from "vitest";
import {
  describeDwellings,
  dwellingBlockedNames,
  findDwellingBody,
  formatDwellingsForEdit,
  isDwellingPair,
  parseDwellingsEdit,
  splitDwellingChanges,
} from "../../../src/core/characterDwelling";
import { scoreCharacterChanges } from "../../../src/core/changeSignificance";
import { findMergeCandidates, mergeExtractedCharacters } from "../../../src/core/characterMerge";
import { unifyCharacters } from "../../../src/core/characterUnify";
import { applyCharacterEdits, SettingsEditError } from "../../../src/core/settingsEdit";
import { describeCharacter } from "../../../src/core/settingsSummary";
import {
  emptyCharacter,
  keepAuthorOnlyMarks,
  parseCharacter,
  type Character,
} from "../../../src/models/character";
import type { RecordChange } from "../../../src/models/jsonValidation";

/**
 * 宿り（作者の裁定、2026-10-18。設計書6.5.13）。
 *
 * 憑依・転生のある作品で、心（三浦太一）が別の人物（灯）の体にいることを作者が記録する。
 * 実データ（いじめられっ子）の形を作り物の名前で写した——体の記録に心の前世が混ざり、
 * 体の別名に心の名前が汚染で入っている。
 */

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

/** 心の側。宿りを持つ */
function dweller(): Character {
  const character = emptyCharacter("char_001", "三浦太一");
  character.aliases = ["太一", "三浦くん"];
  character.dwellings = [{ body: "灯", fromChapter: 4 }];
  return character;
}

/** 体の側。別名に心の名前が入り込み、変化に心の前世が混ざっている */
function body(): Character {
  const character = emptyCharacter("char_002", "灯");
  character.aliases = ["高森灯", "太一", "灯ちゃん"];
  character.appearedChapters = [2, 4, 5, 9, 15];
  character.changes = [
    change("role", "港町の少女", [2]),
    change("role", "太一に宿られた少女", [4]),
    change("role", "転校生。前世は男子小学生", [5]),
    change("role", "旧家の孫娘", [15]),
  ];
  return character;
}

describe("宿りの欄の読み書き", () => {
  test("範囲と補足の書き方を読む", () => {
    expect(parseDwellingsEdit("灯=第4話〜第16話：第17話から灯の心も戻り、同居", "三浦太一")).toEqual([
      { body: "灯", fromChapter: 4, untilChapter: 16, note: "第17話から灯の心も戻り、同居" },
    ]);
    expect(parseDwellingsEdit("灯=第４話から", "三浦太一")).toEqual([{ body: "灯", fromChapter: 4 }]);
    expect(parseDwellingsEdit("灯=〜16", "三浦太一")).toEqual([{ body: "灯", untilChapter: 16 }]);
    expect(parseDwellingsEdit("灯\n\n灯", "三浦太一")).toEqual([{ body: "灯" }]);
  });

  test("書き出した欄を読み戻しても範囲が変わらない（始まりと終わりが同じ話でも）", () => {
    const dwellings = [
      { body: "灯", fromChapter: 4, untilChapter: 4 },
      { body: "高森", fromChapter: 2, note: "夢の中だけ" },
    ];

    expect(parseDwellingsEdit(formatDwellingsForEdit(dwellings), "三浦太一")).toEqual(dwellings);
  });

  test("読めない行は、何行目かを添えて止める（黙って捨てない）", () => {
    expect(() => parseDwellingsEdit("灯=そのうち", "三浦太一")).toThrow(/1行目/);
    expect(() => parseDwellingsEdit("灯=第9話〜第4話", "三浦太一")).toThrow(/前です/);
    expect(() => parseDwellingsEdit("灯\n三浦 太一", "三浦太一")).toThrow(/2行目.*自分自身/);
    expect(() => parseDwellingsEdit("=第4話〜", "三浦太一")).toThrow(/名前がありません/);
  });
});

describe("宿りの読み込みと、作者だけが付け外しすること", () => {
  test("宿りの無い古い資料は、そのまま読める（欄を足さない）", () => {
    const character = parseCharacter({ id: "char_001", name: "三浦太一" });

    expect("dwellings" in character).toBe(false);
  });

  test("宿りを持って読める。壊れた形は読み込みエラーにする", () => {
    const character = parseCharacter({
      id: "char_001",
      name: "三浦太一",
      dwellings: [{ body: "灯", fromChapter: 4 }],
    });

    expect(character.dwellings).toEqual([{ body: "灯", fromChapter: 4 }]);
    expect(() =>
      parseCharacter({ id: "char_001", name: "三浦太一", dwellings: [{ body: "灯", fromChapter: 0 }] })
    ).toThrow();
    expect(() =>
      parseCharacter({ id: "char_001", name: "三浦太一", dwellings: [{ fromChapter: 4 }] })
    ).toThrow();
  });

  test("作者が画面で書けば付き、空にすれば欄ごと消える", () => {
    const written = applyCharacterEdits(emptyCharacter("char_001", "三浦太一"), {
      dwellings: "灯=第4話〜",
    });
    expect(written.dwellings).toEqual([{ body: "灯", fromChapter: 4 }]);

    const cleared = applyCharacterEdits(written, { dwellings: "" });
    expect("dwellings" in cleared).toBe(false);
  });

  test("AIの提案を採る経路（authorConfirmed: false）では動かさない", () => {
    const edited = applyCharacterEdits(
      dweller(),
      { dwellings: "" },
      { authorConfirmed: false }
    );

    expect(edited.dwellings).toEqual([{ body: "灯", fromChapter: 4 }]);
  });

  test("読めない欄は保存を止める", () => {
    expect(() =>
      applyCharacterEdits(emptyCharacter("char_001", "三浦太一"), { dwellings: "灯=いつか" })
    ).toThrow(SettingsEditError);
  });

  test("承認待ちの写しで、いまの記録の宿りを戻さない・消さない", () => {
    const next = emptyCharacter("char_001", "三浦太一");
    expect(keepAuthorOnlyMarks(next, dweller()).dwellings).toEqual([{ body: "灯", fromChapter: 4 }]);

    const stale = { ...emptyCharacter("char_001", "三浦太一"), dwellings: [{ body: "灯" }] };
    expect("dwellings" in keepAuthorOnlyMarks(stale, {})).toBe(false);
  });
});

describe("体の持ち主の引き当て", () => {
  test("名前の一致を先に見る。同じ名前が2人いれば結ばない", () => {
    const people = [dweller(), body()];
    // 別名に「灯」を持つ別人がいても、名前が「灯」の人物へ結ぶ
    const other = { ...emptyCharacter("char_009", "灯子"), aliases: ["灯"] };

    expect(findDwellingBody("灯", [...people, other], people[0])?.id).toBe("char_002");
    expect(findDwellingBody("灯", [...people, { ...body(), id: "char_010" }], people[0])).toBeUndefined();
  });

  test("まとめたあとで名前が別名へ移っても、1人に当たれば結ぶ", () => {
    const merged = { ...body(), name: "高森灯", aliases: ["灯", "灯ちゃん"] };

    expect(findDwellingBody("灯", [dweller(), merged])?.id).toBe("char_002");
  });
});

describe("統合の候補と抽出に、体と心の組を並べない", () => {
  test("宿りが無ければ、汚染された別名で候補に並ぶ（再現）", () => {
    const plain = { ...dweller() };
    delete plain.dwellings;

    expect(findMergeCandidates([plain, body()]).length).toBeGreaterThan(0);
  });

  test("宿りを記録すると、2人は候補に出ない", () => {
    const people = [dweller(), body()];

    expect(isDwellingPair(people[0], people[1], people)).toBe(true);
    expect(findMergeCandidates(people)).toEqual([]);
  });

  test("体の側へ、心の呼び名を別名として足さない。名前の一部でない汚染は止めない", () => {
    const people = [dweller(), body()];

    expect([...dwellingBlockedNames(people[1], people)].sort()).toEqual(
      ["三浦くん", "三浦太一", "太一"].sort()
    );
    // 心の側から見て、体の別名の汚染「太一」は体の呼び名に数えない
    expect(dwellingBlockedNames(people[0], people).has("太一")).toBe(false);
  });

  test("抽出が体の人物に心の名前を付けて返しても、別名に入れない", () => {
    const cleanBody = { ...body(), aliases: ["高森灯"] };
    const result = mergeExtractedCharacters([dweller(), cleanBody], [
      { data: { name: "灯", aliases: ["三浦太一", "灯ちゃん"] }, chapters: [9] },
    ]);
    const merged = result.characters.find((character) => character.id === "char_002");

    expect(merged?.aliases).toContain("灯ちゃん");
    expect(merged?.aliases).not.toContain("三浦太一");
  });

  test("心の呼び名で返った人物は、汚染された別名を持つ体へ寄せない", () => {
    const result = mergeExtractedCharacters([dweller(), body()], [
      { data: { name: "太一", aliases: [] }, chapters: [11] },
    ]);
    const mind = result.characters.find((character) => character.id === "char_001");
    const host = result.characters.find((character) => character.id === "char_002");

    expect(mind?.appearedChapters).toContain(11);
    expect(host?.appearedChapters).not.toContain(11);
  });
});

describe("人物をまとめるとき", () => {
  test("宿りを両方から引き継ぎ、心の呼び名は体の別名へ運ばない", () => {
    const host = body();
    const twin = { ...emptyCharacter("char_003", "高森 灯"), aliases: ["太一"] };
    const { unified } = unifyCharacters(host, twin, [dweller()]);

    expect(unified.aliases).not.toContain("太一");
    // 「高森 灯」は空白違いの「高森灯」として残る
    expect(unified.aliases).toContain("高森灯");
  });

  test("まとめる相手そのものを体とする宿りは落とす", () => {
    const mind = dweller();
    const shadow = { ...emptyCharacter("char_004", "太一（霊）"), dwellings: [{ body: "灯", fromChapter: 4 }] };
    const self = { ...emptyCharacter("char_005", "灯"), dwellings: [{ body: "三浦太一" }] };

    expect(unifyCharacters(mind, shadow, []).unified.dwellings).toEqual([{ body: "灯", fromChapter: 4 }]);
    expect("dwellings" in unifyCharacters(mind, self, []).unified).toBe(false);
  });
});

describe("体の記録を、本人の変化と心の側の記述に分ける", () => {
  test("「前世」「生前」を含む値を分ける。記録そのものは変えない", () => {
    const people = [dweller(), body()];
    const before = JSON.stringify(people[1].changes);
    const split = splitDwellingChanges(people[1], people);

    expect(split.dwelling.map((entry) => entry.value)).toEqual(["転校生。前世は男子小学生"]);
    expect(split.own.map((entry) => entry.value)).toEqual([
      "港町の少女",
      "太一に宿られた少女",
      "旧家の孫娘",
    ]);
    expect(JSON.stringify(people[1].changes)).toBe(before);
  });

  test("宿った心の名前を含むだけの値は、体の持ち主の事実として残す（実データで確かめた形）", () => {
    const host = body();
    host.changes = [
      change("personality", "太一のために怒る情の厚さがある", [17]),
      change("summary", "太一に身体を憑依され、いじめっ子を叩く", [11]),
    ];

    expect(splitDwellingChanges(host, [dweller(), host]).dwelling).toEqual([]);
  });

  test("宿る前の話だけの値は分けない", () => {
    const host = body();
    host.changes = [change("role", "前世の記憶を持つと噂の少女", [2]), change("role", "旧家の孫娘", [15])];

    expect(splitDwellingChanges(host, [dweller(), host]).dwelling).toEqual([]);
  });

  test("体でない人物は、そのまま返す", () => {
    const people = [dweller(), body()];

    expect(splitDwellingChanges(people[0], people).dwelling).toEqual([]);
  });

  test("関与度は本人の変化だけで測る（人物の一覧を渡したとき）", () => {
    const people = [dweller(), body()];
    const roleScore = (context: Parameters<typeof scoreCharacterChanges>[1]) =>
      scoreCharacterChanges(people[1], context).find((entry) => entry.field === "role")?.score;

    // 4つの話で別々の語 → 段が4つで +5、最新の登場話で変わったばかり +5。
    // 心の過去（5話）を外すと段は3つで段の加点が消える
    expect(roleScore({})).toBe(65);
    expect(roleScore({ characters: people })).toBe(60);
  });
});

describe("資料の表示とAIへの材料", () => {
  test("心の側にも体の側にも、宿りの行を出す", () => {
    const people = [
      { ...dweller(), dwellings: [{ body: "灯", fromChapter: 4, note: "第17話から同居" }] },
      body(),
    ];

    expect(describeDwellings(people[0], people)).toEqual([
      { label: "心の入っている体", value: "灯（第4話〜）。第17話から同居" },
    ]);
    expect(describeDwellings(people[1], people)).toEqual([
      { label: "体に入っている心", value: "三浦太一（第4話〜）。第17話から同居" },
    ]);
  });

  test("体の持ち主が資料に無ければ、そう書く", () => {
    const lonely = dweller();

    expect(describeDwellings(lonely, [lonely])[0].value).toBe("灯（資料に見つかりません）（第4話〜）");
  });

  test("材料では、心の側の記述を本人の変化と別の行で渡す", () => {
    const people = [dweller(), body()];
    const text = describeCharacter(people[1], [], { characters: people });

    expect(text).toContain("体に入っている心: 三浦太一（第4話〜）");
    expect(text).toMatch(/変化（role）: [^\n]*港町の少女[^\n]*旧家の孫娘/u);
    expect(text).not.toMatch(/変化（role）: [^\n]*前世/u);
    expect(text).toMatch(/入っている心（三浦太一）の記述（role）: [^\n]*前世は男子小学生/u);
  });

  test("人物の一覧を渡さなければ、今までどおり（宿りの行も仕分けも無い）", () => {
    const text = describeCharacter(body(), []);

    expect(text).not.toContain("体に入っている心");
    expect(text).not.toContain("宿った心");
    expect(text).toMatch(/変化（role）: [^\n]*前世/u);
  });
});
