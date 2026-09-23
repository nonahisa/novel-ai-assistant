import { describe, expect, test } from "vitest";
import {
  buildStoryFactExtractPrompt,
  STORY_FACT_EXTRACT_SCHEMA,
  STORY_FACT_EXTRACT_SYSTEM_PROMPT,
  STORY_FACT_EXTRACT_VERSION,
  STORY_FACT_MAX_ITEMS,
  type StoryFactExtractInput,
} from "../../src/prompts/storyFactExtract";
import { FACT_KINDS, FACT_MODALITIES } from "../../src/models/storyFact";

/**
 * P-37 場面の事実の抽出（設計書6.88、プロンプト設計書 P-37）。
 *
 * **ここで見るのは「矛盾を探させないこと」と「選択肢を値の見本にしないこと」**である。
 * 前者はこの道の前提（矛盾は機械が決める）で、後者はこの作品で繰り返し起きた事故
 * （`"category": "人物|状態|時系列"` が3件中3件返り、検算が全部捨てた。6.10.1）。
 */
function input(overrides: Partial<StoryFactExtractInput> = {}): StoryFactExtractInput {
  return {
    chunkText: "12: 銀髪の少女が振り返った。\n13: 「わたし、明日には発つの」",
    chapterLabel: "第3話",
    chapterNumber: 3,
    knownCharacters: [
      { id: "char_006", name: "密倉文佳", aliases: ["文佳", "文佳ちゃん"] },
      { id: "char_001", name: "月島灯", aliases: [] },
    ],
    knownTopics: ["銀の鍵のありか"],
    ...overrides,
  };
}

describe("プロンプト", () => {
  test("人物は id で返させる（対応表つき）", () => {
    // 表記のまま返させると、同じ人物が場面ごとに別の主語になって照合が当たらない
    const prompt = buildStoryFactExtractPrompt(input());

    expect(prompt).toContain("char_006：密倉文佳（文佳・文佳ちゃん）");
    // 別名が無い人物に、空の括弧を付けない
    expect(prompt).toContain("char_001：月島灯\n");
    expect(prompt).toContain("対応表の id");
  });

  test("対応表が空でも、書き方を示す", () => {
    const prompt = buildStoryFactExtractPrompt(input({ knownCharacters: [] }));

    expect(prompt).toContain("本文の表記のまま書いてください");
  });

  test("既知の topic を渡し、同じ語を使わせる", () => {
    const prompt = buildStoryFactExtractPrompt(input());

    expect(prompt).toContain("- 銀の鍵のありか");
    expect(prompt).toContain("同じ事柄には同じ語");
  });

  test("topic が無ければ、自分で付けさせる", () => {
    const prompt = buildStoryFactExtractPrompt(input({ knownTopics: [] }));

    expect(prompt).toContain("短い語で自分で付けてください");
  });

  test("相対時期の起点を説明する", () => {
    const prompt = buildStoryFactExtractPrompt(input());

    expect(prompt).toContain("day 0 は、第1話のいちばん最初の場面");
    expect(prompt).toContain("いま読んでいるのは第3話です");
    // 読めないときに埋めさせない（設計書6.88.4）
    expect(prompt).toContain("手がかりが無ければ null");
  });

  test("話数が読めなければ、何話目かを書かない", () => {
    const prompt = buildStoryFactExtractPrompt(input({ chapterNumber: null }));

    expect(prompt).not.toContain("いま読んでいるのは第");
    expect(prompt).toContain("day 0 は、第1話のいちばん最初の場面");
  });

  test("矛盾を探させない・評価させない", () => {
    const prompt = buildStoryFactExtractPrompt(input());

    expect(prompt).toContain("矛盾は探さないでください");
    expect(STORY_FACT_EXTRACT_SYSTEM_PROMPT).toContain("矛盾を探さないこと");
    expect(STORY_FACT_EXTRACT_SYSTEM_PROMPT).toContain("評価しないこと");
    expect(STORY_FACT_EXTRACT_SYSTEM_PROMPT).toContain("推測で埋めないこと");
  });

  test("移動は event、台詞には speaker を必ず付けさせる", () => {
    const prompt = buildStoryFactExtractPrompt(input());

    expect(prompt).toContain("移動は必ず event");
    expect(prompt).toContain("speaker に誰の発言かを必ず入れてください");
  });

  test("値は本文の語のまま書かせる", () => {
    expect(buildStoryFactExtractPrompt(input())).toContain("本文の語のまま");
  });

  test("選択肢を、値の見本として書かない", () => {
    // **実データで、モデルは見本をそのまま写して返した**（6.10.1）
    const prompt = buildStoryFactExtractPrompt(input());

    expect(prompt).not.toContain(`"kind": "${FACT_KINDS.join("|")}"`);
    expect(prompt).not.toContain(`"modality": "${FACT_MODALITIES.join("|")}"`);
    expect(prompt).toContain('"kind": "static"');
    expect(prompt).toContain('"modality": "narration"');
  });

  test("選べる語は、値とは別の行で示す", () => {
    const prompt = buildStoryFactExtractPrompt(input());

    expect(prompt).toContain(
      `kind に入れてよい語は次のうち**1つだけ**です：${FACT_KINDS.join("、")}`
    );
    expect(prompt).toContain(
      `modality に入れてよい語は次のうち**1つだけ**です：${FACT_MODALITIES.join("、")}`
    );
  });

  test("行番号つきの本文を、そのまま見せる", () => {
    // ここで振り直すと二重になり、返ってきた行がチャンクの外を指す
    const prompt = buildStoryFactExtractPrompt(input());

    expect(prompt).toContain("12: 銀髪の少女が振り返った。");
    expect(prompt).toContain("各行の左の数字は行番号です");
  });

  test("件数の上限を文面にも出す", () => {
    // 構造化出力に対応していないプロバイダでは、文面しか効かない
    expect(buildStoryFactExtractPrompt(input())).toContain(
      `多くても${STORY_FACT_MAX_ITEMS}件までに`
    );
  });
});

describe("出力の形", () => {
  const item = STORY_FACT_EXTRACT_SCHEMA.properties.facts.items;

  test("すべての項目を必須にする", () => {
    // 任意項目にすると、小さいモデルは埋めずに落とす
    expect([...item.required].sort()).toEqual(
      Object.keys(item.properties).sort()
    );
  });

  test("配列に上限を置く（止まらなくなるのを防ぐ）", () => {
    expect(STORY_FACT_EXTRACT_SCHEMA.properties.facts.maxItems).toBe(
      STORY_FACT_MAX_ITEMS
    );
  });

  test("選べる語は models の一覧をそのまま使う（写しを作らない）", () => {
    expect(item.properties.kind.enum).toBe(FACT_KINDS);
    expect(item.properties.modality.enum).toBe(FACT_MODALITIES);
  });

  test("時期は文字列で受ける（入れ子を崩させない）", () => {
    expect(item.properties.story_time.type).toEqual(["string", "null"]);
  });

  test("版を持つ", () => {
    expect(STORY_FACT_EXTRACT_VERSION).toBe("1.0");
  });
});
