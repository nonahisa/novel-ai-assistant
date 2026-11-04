import { describe, expect, test } from "vitest";
import {
  buildVoiceCastPrompt,
  buildVoiceCastSchema,
  VOICE_CAST_EXAMPLE_NAME,
  voiceCastPersonLine,
} from "../../../src/prompts/voiceCast";
import { validateCastItems } from "../../../src/core/voiceCast";
import { VOICE_EMOTIONS } from "../../../src/core/voiceEngine";

/** P-54 朗読の台詞の話者と感情（設計書6.42.3） */

const people = [
  { id: "a", name: "灯", aliases: ["あかりちゃん"], speechStyle: "丁寧語。\n語尾は「です」" },
  { id: "b", name: "蓮", aliases: [], speechStyle: null },
];

describe("P-54 の頼み方", () => {
  test("台詞の数・人物（名前・別名・口調）・感情の列挙を埋め込む", () => {
    const prompt = buildVoiceCastPrompt({ text: "〔1〕「行こう」", count: 1, people });
    expect(prompt).toContain("台詞が1個あり");
    expect(prompt).toContain("- 灯（別名：あかりちゃん） 口調：丁寧語。 語尾は「です」");
    expect(prompt).toContain("- 蓮\n");
    expect(prompt).toContain(VOICE_EMOTIONS.join("、"));
    expect(prompt).toContain("「不明」");
  });

  test("人物がいなくても頼める", () => {
    expect(buildVoiceCastPrompt({ text: "〔1〕「a」", count: 1, people: [] })).toContain(
      "（登場人物の資料はありません）"
    );
  });

  test("口調は1行に畳んで80字まで", () => {
    const line = voiceCastPersonLine({ id: "x", name: "x", aliases: [], speechStyle: "あ".repeat(200) });
    expect(line.length).toBeLessThan(100);
  });

  test("話者はスキーマの列挙で縛る（名前・別名・不明）", () => {
    const schema = buildVoiceCastSchema(people) as {
      properties: { lines: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } };
    };
    expect(schema.properties.lines.items.properties.speaker.enum).toEqual(["不明", "灯", "あかりちゃん", "蓮"]);
    expect(schema.properties.lines.items.required).toEqual(["number", "speaker", "emotion", "intensity"]);
  });

  /**
   * **見本がそのまま返ってきても採らない**（CLAUDE.md 失敗3番）。見本の名前は
   * 資料に無い語なので、検算が捨てる
   */
  test("見本の答えがそのまま返っても、検算が捨てる", () => {
    const { guesses, dropped } = validateCastItems(
      [{ number: 1, speaker: VOICE_CAST_EXAMPLE_NAME, emotion: "喜び", intensity: "中" }],
      1,
      people
    );
    expect(guesses.size).toBe(0);
    expect(dropped[0].reason).toBe("話者が資料の人物に無い");
  });
});
