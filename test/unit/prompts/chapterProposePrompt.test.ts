import { describe, expect, test } from "vitest";
import {
  buildChapterProposePrompt,
  CHAPTER_NAME_MAX_CHARS,
  CHAPTER_PROPOSE_HINTS,
  CHAPTER_PROPOSE_SCHEMA,
  CHAPTER_PROPOSE_SYSTEM_PROMPT,
  CHAPTER_PROPOSE_VERSION,
  NO_CHAPTERS_MARK,
  type ChapterProposeEpisode,
} from "../../src/prompts/chapterPropose";
import { validateChapterProposal } from "../../src/core/chapterProposalValidation";

/**
 * P-31 章立ての提案のプロンプト（設計書6.66.4）。
 *
 * **指示の言葉は、そのまま答えとして返ってくる**（この作品で繰り返し起きた
 * 失敗3）。だから見本の値は「返ってきても実害が無いもの」だけにし、
 * 実害のあるもの（項目の言い換え）は検証が弾けるようにしてある。
 */

const EPISODES: ChapterProposeEpisode[] = [
  { number: 1, label: "第1話", subtitle: "旅立ちの朝", synopsis: "村を出る" },
  { number: 2, label: "第2話", subtitle: "森の道", synopsis: "" },
  { number: 3, label: "第3話", subtitle: "王都へ", synopsis: "王都に着く" },
];

describe("P-31 章立ての提案のプロンプト", () => {
  test("版が定まっている（キャッシュや再現の手掛かりになる）", () => {
    expect(CHAPTER_PROPOSE_VERSION).toMatch(/^\d+\.\d+$/);
  });

  test("話の一覧とあらすじが材料として入る", () => {
    const prompt = buildChapterProposePrompt({
      workTitle: "氷の街",
      episodes: EPISODES,
      current: [],
    });

    expect(prompt).toContain("氷の街");
    expect(prompt).toContain("第1話");
    expect(prompt).toContain("旅立ちの朝");
    expect(prompt).toContain("村を出る");
    // あらすじの無い話は、印を置かずに黙って落とす（言葉を写されないため）
    expect(prompt).not.toContain("（あらすじはまだありません）");
  });

  test("いまの章立ては「壊さずに直す」ものとして渡る", () => {
    const prompt = buildChapterProposePrompt({
      workTitle: "氷の街",
      episodes: EPISODES,
      current: [{ name: "第一章　出立", startEpisode: 1 }],
    });

    expect(prompt).toContain("第一章　出立");
    expect(prompt).toContain("土台");
    expect(prompt).not.toContain(NO_CHAPTERS_MARK);
  });

  test("章が1つも無ければ、その旨を書く（作者の章名を捏造させない）", () => {
    const prompt = buildChapterProposePrompt({
      workTitle: "氷の街",
      episodes: EPISODES,
      current: [],
    });
    expect(prompt).toContain(NO_CHAPTERS_MARK);
  });

  test("見本の開始話数は、実在する最初の話（そのまま返っても実害が無い）", () => {
    const prompt = buildChapterProposePrompt({
      workTitle: "氷の街",
      // わざと第1話から始まらない作品にする。見本を固定値にしていると、
      // ここで実在しない「1」が見本になり、返ってきた提案が全部捨てられる
      episodes: EPISODES.map((episode) => ({
        ...episode,
        number: episode.number + 10,
        label: `第${episode.number + 10}話`,
      })),
      current: [],
    });

    expect(prompt).toContain('"startEpisode": 11');

    // 見本をそのまま返した応答も、検証を通って提案として残る
    const { accepted } = validateChapterProposal(
      { chapters: [{ name: "出立の章", startEpisode: 11, reason: "" }] },
      [11, 12, 13]
    );
    expect(accepted).toHaveLength(1);
  });

  test("名前の見本は項目の言い換えで、返ってきたら検証が弾く", () => {
    const prompt = buildChapterProposePrompt({
      workTitle: "氷の街",
      episodes: EPISODES,
      current: [],
    });

    for (const hint of CHAPTER_PROPOSE_HINTS) {
      expect(prompt).toContain(hint);
    }
    const { accepted } = validateChapterProposal(
      {
        chapters: [
          {
            name: CHAPTER_PROPOSE_HINTS[0],
            startEpisode: 1,
            reason: CHAPTER_PROPOSE_HINTS[1],
          },
        ],
      },
      [1, 2, 3]
    );
    expect(accepted).toHaveLength(0);
  });

  test("字数の上限は定数と同じものを書く（別々に書かない）", () => {
    const prompt = buildChapterProposePrompt({
      workTitle: "氷の街",
      episodes: EPISODES,
      current: [],
    });
    expect(prompt).toContain(`${CHAPTER_NAME_MAX_CHARS}字`);
  });

  test("章名だけを頼むときは、区切りを変えさせない", () => {
    const prompt = buildChapterProposePrompt({
      workTitle: "氷の街",
      episodes: EPISODES,
      current: [{ name: "第一章", startEpisode: 1 }],
      nameOnly: { maxSuggestions: 3 },
    });

    expect(prompt).toContain("3");
    expect(prompt).toContain("区切り");
    // 範囲は動かさないので、開始の話数は1つに固定して渡す
    expect(prompt).toContain('"startEpisode": 1');
  });

  test("システムプロンプトは、材料に無いことを書かせない", () => {
    expect(CHAPTER_PROPOSE_SYSTEM_PROMPT).toContain("JSON");
    expect(CHAPTER_PROPOSE_SYSTEM_PROMPT.length).toBeGreaterThan(50);
  });

  test("スキーマは3つとも必須にする（小さいモデルが項目を落とすため）", () => {
    const items = CHAPTER_PROPOSE_SCHEMA.properties.chapters.items;
    expect(items.required).toEqual(["name", "startEpisode", "reason"]);
    expect(items.properties.startEpisode.type).toBe("integer");
  });
});
