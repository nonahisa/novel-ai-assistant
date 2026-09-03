import { describe, expect, test } from "vitest";
import {
  describeChapterRejectReasons,
  parseChapterProposeResult,
  validateChapterNames,
  validateChapterProposal,
} from "../../src/core/chapterProposalValidation";
import {
  CHAPTER_NAME_MAX_CHARS,
  CHAPTER_PROPOSE_HINTS,
} from "../../src/prompts/chapterPropose";

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
