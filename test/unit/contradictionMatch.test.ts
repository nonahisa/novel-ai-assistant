import { describe, expect, it } from "vitest";
import { buildAttributeIntervals } from "../../src/core/attributeIntervals";
import {
  filterAllowed,
  findContradictionCandidates,
  findIntervalConflicts,
  findKnowledgeViolations,
  findPostDeathAppearances,
  findTravelImpossibilities,
  fingerprintOf,
} from "../../src/core/contradictionMatch";
import type {
  IdentityTransition,
  StoryFact,
} from "../../src/models/storyFact";

/**
 * 機械照合（設計書6.88.6）。**LLMを使わない。**
 *
 * 第1段では、手で書いた事実に対するこの単体テストが評価である（6.88.7）。
 * **迷ったら出さない**——知り得たか分からない知識、所要時間の表が無い移動は
 * 候補にしない。
 */

function fact(overrides: Partial<StoryFact> & { id: string }): StoryFact {
  return {
    id: overrides.id,
    chapter: 1,
    lineRange: [1, 1],
    subject: "char_001",
    predicate: "髪の色",
    value: "銀",
    kind: "static",
    storyTime: null,
    modality: "narration",
    pov: null,
    speaker: null,
    topic: null,
    ...overrides,
  };
}

/** 「12日目 夕に銀、14日目 朝に黒」——変化の記録が無い形 */
function hairFacts(overrides: {
  left?: Partial<StoryFact>;
  right?: Partial<StoryFact>;
}): StoryFact[] {
  return [
    fact({
      id: "f1",
      chapter: 12,
      lineRange: [340, 352],
      value: "銀",
      storyTime: { day: 12, part: "夕" },
      ...overrides.left,
    }),
    fact({
      id: "f2",
      chapter: 14,
      lineRange: [10, 12],
      value: "黒",
      storyTime: { day: 14, part: "朝" },
      ...overrides.right,
    }),
  ];
}

describe("区間の重なり", () => {
  it("地の文どうしなら確信度は high", () => {
    const candidates = findIntervalConflicts(
      buildAttributeIntervals(hairFacts({}))
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      type: "設定",
      subject: "char_001",
      predicate: "髪の色",
      left: "f1",
      right: "f2",
      confidence: "high",
    });
    expect(candidates[0].reason).toBe(
      "12日目 夕に『銀』、14日目 朝に『黒』。あいだに変化の記録が無い"
    );
  });

  it("片方が台詞なら medium（人物は嘘をつくし、勘違いもする）", () => {
    const candidates = findIntervalConflicts(
      buildAttributeIntervals(
        hairFacts({ right: { modality: "dialogue", speaker: "char_002" } })
      )
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe("medium");
  });

  it("片方が噂なら low", () => {
    const candidates = findIntervalConflicts(
      buildAttributeIntervals(hairFacts({ right: { modality: "rumor" } }))
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe("low");
  });

  it("あいだに変化イベントがあれば候補にしない", () => {
    const facts = [
      ...hairFacts({}),
      fact({
        id: "e1",
        chapter: 13,
        kind: "event",
        value: "黒く染めた",
        storyTime: { day: 13, part: "昼" },
      }),
    ];
    expect(findIntervalConflicts(buildAttributeIntervals(facts))).toEqual([]);
  });

  it("同じ値なら候補にしない", () => {
    const facts = hairFacts({ right: { value: "銀" } });
    expect(findIntervalConflicts(buildAttributeIntervals(facts))).toEqual([]);
  });

  it("時間の語は「時系列」として出す", () => {
    const facts = hairFacts({
      left: { predicate: "年齢", value: "17" },
      right: { predicate: "年齢", value: "15" },
    });
    const candidates = findIntervalConflicts(buildAttributeIntervals(facts));
    expect(candidates[0].type).toBe("時系列");
  });

  it("state 由来なら「状態」として出す", () => {
    const facts = hairFacts({
      left: { predicate: "怪我", value: "右腕を骨折", kind: "state" },
      right: { predicate: "怪我", value: "無傷", kind: "state" },
    });
    const candidates = findIntervalConflicts(buildAttributeIntervals(facts));
    expect(candidates[0].type).toBe("状態");
  });

  /**
   * 同じ日で区分が読めない組。**候補にはするが、確信度を1段下げる。**
   * 前後が読めないものを「後で変わった」とも「矛盾だ」とも言い切れない。
   */
  it("同じ日で前後が読めないときは、確信度を1段下げて理由に書く", () => {
    const facts = hairFacts({
      left: { storyTime: { day: 12, part: null } },
      right: { chapter: 12, storyTime: { day: 12, part: "朝" } },
    });
    const candidates = findIntervalConflicts(buildAttributeIntervals(facts));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe("medium");
    expect(candidates[0].reason).toContain("同じ日で前後が読めない");
  });
});

describe("死亡後の登場", () => {
  const death = fact({
    id: "d1",
    subject: "char_009",
    chapter: 5,
    kind: "event",
    predicate: "死亡",
    value: "",
    storyTime: { day: 10, part: "夜" },
  });

  it("死んだあとに出てきたら候補にする", () => {
    const appearance = fact({
      id: "a1",
      subject: "char_009",
      chapter: 6,
      kind: "state",
      predicate: "所在",
      value: "教室",
      storyTime: { day: 12, part: "朝" },
    });
    const candidates = findPostDeathAppearances([death, appearance]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      type: "状態",
      subject: "char_009",
      left: "d1",
      right: "a1",
    });
  });

  it("回想（thought）は死後の登場にしない", () => {
    const recollection = fact({
      id: "a0",
      subject: "char_009",
      chapter: 6,
      modality: "thought",
      predicate: "所在",
      value: "校庭",
      storyTime: { day: 11, part: "朝" },
    });
    expect(findPostDeathAppearances([death, recollection])).toEqual([]);
  });

  it("幽霊の遷移が記録されていれば候補にしない", () => {
    const appearance = fact({
      id: "a1",
      subject: "char_009",
      chapter: 6,
      predicate: "所在",
      value: "教室",
      storyTime: { day: 12, part: "朝" },
    });
    const transitions: IdentityTransition[] = [
      {
        subject: "char_009",
        kind: "ghost",
        at: { storyTime: { day: 11, part: "夜" }, chapter: 5, line: 90 },
      },
    ];
    expect(
      findPostDeathAppearances([death, appearance], transitions)
    ).toEqual([]);
  });

  it("死ぬ前の事実は候補にしない", () => {
    const before = fact({
      id: "b1",
      subject: "char_009",
      chapter: 2,
      predicate: "所在",
      value: "教室",
      storyTime: { day: 3, part: "朝" },
    });
    expect(findPostDeathAppearances([death, before])).toEqual([]);
  });

  it("死後に何度出てきても、出すのは最初の1件だけ", () => {
    const facts = [
      death,
      fact({
        id: "a1",
        subject: "char_009",
        chapter: 6,
        predicate: "所在",
        value: "教室",
        storyTime: { day: 12, part: "朝" },
      }),
      fact({
        id: "a2",
        subject: "char_009",
        chapter: 7,
        predicate: "所在",
        value: "校庭",
        storyTime: { day: 13, part: "朝" },
      }),
    ];
    const candidates = findPostDeathAppearances(facts);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].right).toBe("a1");
  });
});

describe("知識", () => {
  const acquired = fact({
    id: "k1",
    subject: "char_002",
    chapter: 5,
    kind: "knowledge",
    predicate: "知る",
    value: "王の死を知らされた",
    topic: "王の死",
    storyTime: { day: 5, part: "朝" },
  });

  it("知る前に口にしていたら候補にする", () => {
    const spoken = fact({
      id: "s1",
      subject: "char_002",
      chapter: 3,
      modality: "dialogue",
      speaker: "char_002",
      topic: "王の死",
      predicate: "発言",
      value: "王が亡くなったそうだ",
      storyTime: { day: 3, part: "夕" },
    });
    const candidates = findKnowledgeViolations([acquired, spoken]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      type: "知識",
      subject: "char_002",
      predicate: "王の死",
      left: "s1",
      right: "k1",
      confidence: "medium",
    });
  });

  it("知ったあとの発言は候補にしない", () => {
    const spoken = fact({
      id: "s2",
      subject: "char_002",
      chapter: 7,
      modality: "dialogue",
      speaker: "char_002",
      topic: "王の死",
      predicate: "発言",
      value: "王が亡くなったそうだ",
      storyTime: { day: 7, part: "夕" },
    });
    expect(findKnowledgeViolations([acquired, spoken])).toEqual([]);
  });

  /** 知り得たかどうか分からないものを矛盾と言わない */
  it("獲得の記録が無い topic は候補にしない", () => {
    const spoken = fact({
      id: "s3",
      subject: "char_002",
      chapter: 3,
      modality: "dialogue",
      speaker: "char_002",
      topic: "隠し通路",
      predicate: "発言",
      value: "地下に道がある",
      storyTime: { day: 3, part: "夕" },
    });
    expect(findKnowledgeViolations([acquired, spoken])).toEqual([]);
  });

  it("別の人物が知っていても、発言者が知らなければ関係ない", () => {
    const spoken = fact({
      id: "s4",
      subject: "char_003",
      chapter: 3,
      modality: "dialogue",
      speaker: "char_003",
      topic: "王の死",
      predicate: "発言",
      value: "王が亡くなったそうだ",
      storyTime: { day: 3, part: "夕" },
    });
    expect(findKnowledgeViolations([acquired, spoken])).toEqual([]);
  });
});

describe("移動可能性", () => {
  const facts = [
    fact({
      id: "m1",
      subject: "char_004",
      chapter: 2,
      kind: "state",
      predicate: "所在",
      value: "王都",
      storyTime: { day: 3, part: "朝" },
    }),
    fact({
      id: "m2",
      subject: "char_004",
      chapter: 3,
      kind: "state",
      predicate: "所在",
      value: "港町",
      storyTime: { day: 4, part: "朝" },
    }),
  ];

  it("所要2日の道のりを1日で移っていたら候補にする", () => {
    const candidates = findTravelImpossibilities(facts, [
      { from: "王都", to: "港町", minDays: 2 },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      type: "時系列",
      predicate: "所在",
      left: "m1",
      right: "m2",
    });
    expect(candidates[0].reason).toContain("2日かかる道のりを1日で移っている");
  });

  /** 作品ごとに地理も移動手段も違う。こちらが日数を推測しない */
  it("所要時間の表が無ければ照合しない", () => {
    expect(findTravelImpossibilities(facts, [])).toEqual([]);
    expect(
      findTravelImpossibilities(facts, [
        { from: "王都", to: "山村", minDays: 5 },
      ])
    ).toEqual([]);
  });

  it("間に合っていれば候補にしない", () => {
    expect(
      findTravelImpossibilities(facts, [
        { from: "王都", to: "港町", minDays: 1 },
      ])
    ).toEqual([]);
  });

  it("時期が読めない事実は照合しない", () => {
    const unreadable = facts.map((entry) => ({ ...entry, storyTime: null }));
    expect(
      findTravelImpossibilities(unreadable, [
        { from: "王都", to: "港町", minDays: 2 },
      ])
    ).toEqual([]);
  });
});

describe("指紋と容認", () => {
  it("中身が同じなら、左右を入れ替えても同じ指紋になる", () => {
    const left = fingerprintOf({
      type: "設定",
      subject: "char_001",
      predicate: "髪の色",
      values: ["銀", "黒"],
    });
    const right = fingerprintOf({
      type: "設定",
      subject: "char_001",
      predicate: "髪の色",
      values: ["黒", "銀"],
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{40}$/);
  });

  it("型が違えば別の指紋になる", () => {
    const base = {
      subject: "char_001",
      predicate: "髪の色",
      values: ["銀", "黒"],
    };
    expect(fingerprintOf({ ...base, type: "設定" })).not.toBe(
      fingerprintOf({ ...base, type: "状態" })
    );
  });

  it("容認した指紋の候補は落ちる", () => {
    const candidates = findIntervalConflicts(
      buildAttributeIntervals(hairFacts({}))
    );
    expect(candidates).toHaveLength(1);
    expect(filterAllowed(candidates, [candidates[0].fingerprint])).toEqual([]);
    expect(filterAllowed(candidates, ["別の指紋"])).toHaveLength(1);
  });
});

describe("まとめて照合する", () => {
  it("同じ指紋の候補は1件にまとめる", () => {
    const candidates = findContradictionCandidates({ facts: hairFacts({}) });
    expect(candidates).toHaveLength(1);
  });

  /**
   * 憑依（文佳の体で太志が喋る）。第1段では**別の subject の事実**として
   * 扱うので、口調が違っても矛盾にならない。肉体・人格・身分の3つ組は
   * 第2段（6.88.5）で入れる。
   */
  it("憑依は、別の人物の事実として矛盾にしない", () => {
    const facts = [
      fact({
        id: "p1",
        subject: "char_文佳",
        chapter: 1,
        predicate: "口調",
        value: "丁寧",
        storyTime: { day: 1, part: "朝" },
      }),
      fact({
        id: "p2",
        subject: "char_太志",
        chapter: 9,
        predicate: "口調",
        value: "乱暴",
        storyTime: { day: 9, part: "朝" },
      }),
    ];
    expect(findContradictionCandidates({ facts })).toEqual([]);
  });

  it("事実が無ければ候補も出ない", () => {
    expect(findContradictionCandidates({ facts: [] })).toEqual([]);
  });
});

describe("所在は区間の重なりで見ない（本体の判断、0.46.0）", () => {
  it("同じ人物の所在が変わっても、変化イベントが無いだけでは候補にしない", () => {
    const facts: StoryFact[] = [
      fact({ id: "w1", subject: "char_001", predicate: "所在", value: "学校", storyTime: { day: 1, part: "朝" } }),
      fact({ id: "w2", subject: "char_001", predicate: "所在", value: "自宅", storyTime: { day: 1, part: "夜" } }),
    ];
    const found = findIntervalConflicts(buildAttributeIntervals(facts));
    expect(found).toEqual([]);
  });
});

