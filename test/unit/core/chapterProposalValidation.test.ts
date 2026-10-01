import { describe, expect, test } from "vitest";
import {
  classifyChapterBoundaries,
  describeChapterBoundary,
  describeChapterRejectReasons,
  parseChapterProposeResult,
  validateChapterNames,
  validateChapterProposal,
} from "../../../src/core/chapterProposalValidation";
import {
  CHAPTER_NAME_MAX_CHARS,
  CHAPTER_PROPOSE_HINTS,
} from "../../../src/prompts/chapterPropose";

/**
 * 章立ての提案（P-31）の検証（設計書6.66.4）。
 *
 * **AIの出力を信用しない。** 見るのは4つ——開始の話数が実在するか、
 * 昇順か、重ならないか、名前が空でないか。
 *
 * **壊れた1件だけを捨てて、残りは通す。** 章分けは作品まるごとで1回しか
 * 呼ばないので、1件の不備で全部を捨てると、作者はもう一度AIを呼ぶことになる
 * （有料AIでは、そのぶん課金される）。
 */

/** 第1〜10話まである作品 */
const EPISODES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function proposal(
  chapters: Array<Record<string, unknown>>
): { chapters: Array<Record<string, unknown>> } {
  return { chapters };
}

describe("章分けの提案の検証", () => {
  test("実在しない話数の1件だけが捨てられ、残りは通る", () => {
    const { accepted, rejected } = validateChapterProposal(
      proposal([
        { name: "旅立ちの章", startEpisode: 1, reason: "出発するまで" },
        { name: "幻の章", startEpisode: 99, reason: "存在しない話" },
        { name: "戦いの章", startEpisode: 6, reason: "戦いが始まる" },
      ]),
      EPISODES
    );

    expect(accepted.map((entry) => entry.startEpisode)).toEqual([1, 6]);
    expect(rejected).toEqual([
      { raw: expect.anything(), reason: "unknown_episode" },
    ]);
  });

  test("昇順でない1件だけが捨てられる", () => {
    const { accepted, rejected } = validateChapterProposal(
      proposal([
        { name: "第一の章", startEpisode: 3, reason: "" },
        { name: "巻き戻った章", startEpisode: 2, reason: "" },
        { name: "第三の章", startEpisode: 8, reason: "" },
      ]),
      EPISODES
    );

    expect(accepted.map((entry) => entry.startEpisode)).toEqual([3, 8]);
    expect(rejected.map((entry) => entry.reason)).toEqual(["out_of_order"]);
  });

  test("同じ話から始まる2件目だけが捨てられる", () => {
    const { accepted, rejected } = validateChapterProposal(
      proposal([
        { name: "出立の章", startEpisode: 1, reason: "" },
        { name: "別名の章", startEpisode: 1, reason: "" },
        { name: "終わりの章", startEpisode: 9, reason: "" },
      ]),
      EPISODES
    );

    expect(accepted.map((entry) => entry.name)).toEqual([
      "出立の章",
      "終わりの章",
    ]);
    expect(rejected.map((entry) => entry.reason)).toEqual(["duplicate_start"]);
  });

  test("名前が空の1件だけが捨てられる", () => {
    const { accepted, rejected } = validateChapterProposal(
      proposal([
        { name: "   ", startEpisode: 1, reason: "" },
        { name: "王都の章", startEpisode: 4, reason: "" },
      ]),
      EPISODES
    );

    expect(accepted.map((entry) => entry.name)).toEqual(["王都の章"]);
    expect(rejected.map((entry) => entry.reason)).toEqual(["placeholder"]);
  });

  test("形が違う1件（数字でない開始話）だけが捨てられる", () => {
    const { accepted, rejected } = validateChapterProposal(
      proposal([
        { name: "序の章", startEpisode: "第1話", reason: "" },
        { name: "王都の章", startEpisode: 4, reason: "" },
      ]),
      EPISODES
    );

    expect(accepted.map((entry) => entry.name)).toEqual(["王都の章"]);
    expect(rejected.map((entry) => entry.reason)).toEqual(["shape"]);
  });

  test("全部壊れていれば、通るものが1件も無い（提案なしとして報告できる）", () => {
    const { accepted, rejected } = validateChapterProposal(
      proposal([
        { name: "", startEpisode: 1, reason: "" },
        { name: "幻", startEpisode: 42, reason: "" },
        { startEpisode: 3 },
      ]),
      EPISODES
    );

    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(3);
    // 内訳が読めること。数だけでは、プロンプトを直すべきかが決まらない
    expect(describeChapterRejectReasons(rejected)).toContain("件");
  });

  test("長すぎる名前は捨てずに切り詰める（理由まで一緒に消さない）", () => {
    const long = "あ".repeat(CHAPTER_NAME_MAX_CHARS + 10);
    const { accepted, rejected } = validateChapterProposal(
      proposal([{ name: long, startEpisode: 1, reason: "長い名前" }]),
      EPISODES
    );

    expect(rejected).toHaveLength(0);
    expect(accepted[0].name.length).toBeLessThanOrEqual(
      CHAPTER_NAME_MAX_CHARS + 1
    );
    expect(accepted[0].reason).toBe("長い名前");
  });

  test("指示の言葉がそのまま名前として返ってきたら捨てる", () => {
    for (const hint of CHAPTER_PROPOSE_HINTS) {
      const { accepted, rejected } = validateChapterProposal(
        proposal([{ name: hint, startEpisode: 1, reason: "" }]),
        EPISODES
      );
      expect(accepted).toHaveLength(0);
      expect(rejected.map((entry) => entry.reason)).toEqual(["placeholder"]);
    }
  });

  test("指示の言葉が理由として返ってきたら、理由だけを空にする（章は残す）", () => {
    const { accepted } = validateChapterProposal(
      proposal([
        { name: "出立の章", startEpisode: 1, reason: CHAPTER_PROPOSE_HINTS[1] },
      ]),
      EPISODES
    );

    expect(accepted).toHaveLength(1);
    expect(accepted[0].reason).toBe("");
  });

  test("「第一章」だけの名前は通す（作者が直せる、実害の無い名前）", () => {
    const { accepted } = validateChapterProposal(
      proposal([{ name: "第一章", startEpisode: 1, reason: "" }]),
      EPISODES
    );
    expect(accepted.map((entry) => entry.name)).toEqual(["第一章"]);
  });

  test("最初の章が第1話から始まらなくてもよい（プロローグを章に入れない）", () => {
    const { accepted, rejected } = validateChapterProposal(
      proposal([{ name: "本編の章", startEpisode: 2, reason: "" }]),
      EPISODES
    );
    expect(rejected).toHaveLength(0);
    expect(accepted[0].startEpisode).toBe(2);
  });

  test("chapters が無い応答は、提案0件として扱う", () => {
    expect(validateChapterProposal({ foo: 1 }, EPISODES).accepted).toEqual([]);
    expect(validateChapterProposal(null, EPISODES).accepted).toEqual([]);
  });
});

describe("応答の読み取り", () => {
  test("コードフェンス付きでも読める", () => {
    const parsed = parseChapterProposeResult(
      '```json\n{"chapters":[{"name":"章","startEpisode":1,"reason":""}]}\n```'
    );
    expect(parsed?.chapters).toHaveLength(1);
  });

  test("前置きが付いていても読める", () => {
    const parsed = parseChapterProposeResult(
      'はい、こちらです。{"chapters":[]}'
    );
    expect(parsed?.chapters).toEqual([]);
  });

  test("読めなければ null", () => {
    expect(parseChapterProposeResult("すみません、できません")).toBeNull();
  });
});

describe("章名だけの提案の検証", () => {
  /** 第4〜7話がその章の範囲 */
  const RANGE = [4, 5, 6, 7];

  test("同じ範囲を指す案が最大3つまで返る", () => {
    const { names, rejected } = validateChapterNames(
      proposal([
        { name: "王都の陰謀", startEpisode: 4, reason: "" },
        { name: "灯を継ぐ者", startEpisode: 4, reason: "" },
        { name: "はじまりの雨", startEpisode: 5, reason: "" },
        { name: "四つめの案", startEpisode: 4, reason: "" },
      ]),
      RANGE,
      3
    );

    expect(names).toEqual(["王都の陰謀", "灯を継ぐ者", "はじまりの雨"]);
    expect(rejected).toHaveLength(0);
  });

  test("範囲の外の話数を指す案は捨てる", () => {
    const { names, rejected } = validateChapterNames(
      proposal([
        { name: "この章の名前", startEpisode: 9, reason: "" },
        { name: "王都の陰謀", startEpisode: 4, reason: "" },
      ]),
      RANGE,
      3
    );

    expect(names).toEqual(["王都の陰謀"]);
    expect(rejected.map((entry) => entry.reason)).toEqual(["unknown_episode"]);
  });

  test("同じ名前は1つにまとめる（選びようがない）", () => {
    const { names } = validateChapterNames(
      proposal([
        { name: "王都の陰謀", startEpisode: 4, reason: "" },
        { name: " 王都の陰謀 ", startEpisode: 5, reason: "" },
      ]),
      RANGE,
      3
    );
    expect(names).toEqual(["王都の陰謀"]);
  });

  test("指示の言葉だけが返ってきたら、案は1つも無い", () => {
    const { names, rejected } = validateChapterNames(
      proposal([
        { name: CHAPTER_PROPOSE_HINTS[0], startEpisode: 4, reason: "" },
      ]),
      RANGE,
      3
    );
    expect(names).toEqual([]);
    expect(rejected.map((entry) => entry.reason)).toEqual(["placeholder"]);
  });
});

/**
 * 既存の区切りとの照合（作者の裁定 2026-10-01、判断 i。測定記録の不具合14）。
 *
 * **作者が決めた章の始まりを動かす提案も、落とさずに残して印を付ける。**
 * 印はコードが付ける（AIに「動かしたか」を答えさせない。規則3）。
 */
describe("既存の区切りとの照合", () => {
  const current = [
    { name: "第一章", startEpisode: 1 },
    { name: "第二章", startEpisode: 50 },
    { name: "第三章", startEpisode: 102 },
    { name: "第四章", startEpisode: 128 },
  ];

  test("第102話→第100話・第128話→第129話は「動かす」の印、同じ区切りは印なし", () => {
    const boundaries = classifyChapterBoundaries(
      [1, 50, 100, 129].map((startEpisode) => ({ startEpisode })),
      current
    );
    expect(boundaries).toEqual([
      { kind: "same", existingName: "第一章" },
      { kind: "same", existingName: "第二章" },
      { kind: "moved", fromEpisode: 102, fromName: "第三章" },
      { kind: "moved", fromEpisode: 128, fromName: "第四章" },
    ]);
  });

  test("まだ章の無い範囲への提案は「新しい区切り」", () => {
    const boundaries = classifyChapterBoundaries(
      [1, 30].map((startEpisode) => ({ startEpisode })),
      [{ name: "第一章", startEpisode: 1 }]
    );
    expect(boundaries).toEqual([
      { kind: "same", existingName: "第一章" },
      { kind: "new" },
    ]);
  });

  test("章立てが空なら、どれも新しい区切り", () => {
    const boundaries = classifyChapterBoundaries(
      [1, 6].map((startEpisode) => ({ startEpisode })),
      []
    );
    expect(boundaries.map((entry) => entry.kind)).toEqual(["new", "new"]);
  });

  test("残る区切りをまたいで「動かした」とは見なさない", () => {
    // 第10話の区切りは残る。その向こうの第60話を、手前の第5話へ
    // 動かしたことにはしない（間の章ごと飛び越えてしまう）
    const boundaries = classifyChapterBoundaries(
      [5, 10].map((startEpisode) => ({ startEpisode })),
      [
        { name: "甲", startEpisode: 10 },
        { name: "乙", startEpisode: 60 },
      ]
    );
    expect(boundaries).toEqual([
      { kind: "new" },
      { kind: "same", existingName: "甲" },
    ]);
  });

  test("開始の話が分からない章は照合に使わない", () => {
    const boundaries = classifyChapterBoundaries(
      [{ startEpisode: 3 }],
      [{ name: "迷子の章", startEpisode: null }]
    );
    expect(boundaries).toEqual([{ kind: "new" }]);
  });

  test("1つの既存の区切りを、2つの提案の元にしない", () => {
    const boundaries = classifyChapterBoundaries(
      [99, 101].map((startEpisode) => ({ startEpisode })),
      [{ name: "第三章", startEpisode: 100 }]
    );
    expect(
      boundaries.filter((entry) => entry.kind === "moved")
    ).toHaveLength(1);
  });

  test("動かす提案の文言は短く、いまの開始の話を言う", () => {
    const labelOf = (number: number) => `第${number}話`;
    expect(
      describeChapterBoundary(
        { kind: "moved", fromEpisode: 102, fromName: "第三章" },
        labelOf
      )
    ).toBe("既存の区切りを動かします（いま第102話から）");
    expect(describeChapterBoundary({ kind: "new" }, labelOf)).toBe(
      "新しい区切り"
    );
    expect(
      describeChapterBoundary({ kind: "same", existingName: "第一章" }, labelOf)
    ).toBe("既存の区切りと同じ");
  });
});
