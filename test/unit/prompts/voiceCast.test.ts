import { describe, expect, test } from "vitest";
import {
  buildVoiceCastPrompt,
  buildVoiceCastSchema,
  buildVoiceCastEmotionPrompt,
  buildVoiceCastEmotionSchema,
  buildVoiceCastSpeakerPrompt,
  buildVoiceCastSpeakerSchema,
  VOICE_CAST_EXAMPLE_NAME,
  voiceCastStageRequests,
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

  test("版1.2：話者の決まった番号は、話者を考える番号から外して伝える（名前は番号に添えない）", () => {
    const prompt = buildVoiceCastPrompt({
      text: "〔1〕「行こう」と灯は言った。\n〔2〕「どこへ」\n〔3〕「港」と蓮が答えた。",
      count: 3,
      people,
      decided: [3, 1],
    });
    expect(prompt).toContain("気持ちと強さだけを答えてください：〔1〕〔3〕");
    expect(prompt).toContain("話者を考えるのは〔2〕です。");
    expect(prompt).not.toContain("〔1：");
    const all = buildVoiceCastPrompt({ text: "〔1〕「a」", count: 1, people, decided: [1] });
    expect(all).toContain("話者を考える台詞はありません。");
  });

  test("話者の決まった台詞が無ければ、その節を出さない", () => {
    const prompt = buildVoiceCastPrompt({ text: "〔1〕「a」", count: 1, people, decided: [] });
    expect(prompt).not.toContain("話者が決まっています");
    expect(prompt).toContain("答えてください。\n\n【登場人物】");
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

/**
 * 案 B「訊き方を2段に分ける」（版1.3）。1段目は話者だけ、2段目は感情と強さだけ。
 * **段ごとに、もう一方の欄を頼み方にもスキーマにも出さない**（出すと小さいモデルは両方を考え、
 * 1回で訊いたときと同じになる）。
 */
describe("P-54 版1.3：2段の頼み方", () => {
  test("1段目は話者だけを訊く。感情の列挙もスキーマの感情の欄も出さない", () => {
    const prompt = buildVoiceCastSpeakerPrompt({
      text: "〔1〕「行こう」\n〔2〕「どこへ」",
      count: 2,
      people,
      before: "前の地の文。",
      after: "後ろの地の文。",
    });
    expect(prompt).toContain("- 灯（別名：あかりちゃん） 口調：丁寧語。 語尾は「です」");
    expect(prompt).toContain("〔1〕「行こう」");
    expect(prompt).toContain("【この区切りの前の本文】");
    expect(prompt).toContain("前の地の文。");
    expect(prompt).toContain("後ろの地の文。");
    expect(prompt).toContain("「不明」");
    expect(prompt).not.toContain(VOICE_EMOTIONS.join("、"));
    expect(prompt).not.toContain("emotion");
    const schema = buildVoiceCastSpeakerSchema(people) as {
      properties: { lines: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } };
    };
    expect(Object.keys(schema.properties.lines.items.properties)).toEqual(["number", "speaker"]);
    expect(schema.properties.lines.items.required).toEqual(["number", "speaker"]);
    expect(schema.properties.lines.items.properties.speaker.enum).toEqual(["不明", "灯", "あかりちゃん", "蓮"]);
  });

  test("1段目：本文に話者が書いてある番号は訊かない（名前は添えない）。前後の本文が無ければ節を出さない", () => {
    const prompt = buildVoiceCastSpeakerPrompt({
      text: "〔1〕「行こう」と灯は言った。\n〔2〕「どこへ」\n〔3〕「港」と蓮が答えた。",
      count: 3,
      people,
      decided: [3, 1],
    });
    expect(prompt).toContain("答えるのは〔2〕だけです");
    expect(prompt).toContain("〔1〕〔3〕は、本文に話し手が書いてあるので答えません");
    expect(prompt).not.toContain("〔1：");
    expect(prompt).not.toContain("【この区切りの前の本文】");
    expect(prompt).not.toContain("【この区切りのあとの本文】");
  });

  test("2段目は感情と強さだけを訊く。人物の一覧もスキーマの話者の欄も出さない", () => {
    const prompt = buildVoiceCastEmotionPrompt({ text: "〔1〕「やった！」", count: 1 });
    expect(prompt).toContain(VOICE_EMOTIONS.join("、"));
    expect(prompt).toContain("〔1〕「やった！」");
    expect(prompt).not.toContain("【登場人物】");
    expect(prompt).not.toContain("speaker");
    expect(prompt).not.toContain(VOICE_CAST_EXAMPLE_NAME);
    const schema = buildVoiceCastEmotionSchema() as {
      properties: { lines: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    expect(Object.keys(schema.properties.lines.items.properties)).toEqual(["number", "emotion", "intensity"]);
    expect(schema.properties.lines.items.required).toEqual(["number", "emotion", "intensity"]);
  });

  test("区切りごとの頼み：全部の番号がコードで決まった区切りは、1段目を作らない", () => {
    const chunk = {
      text: "〔1〕「行こう」と灯は言った。",
      dialogues: [{ index: 0, start: 0, end: 5, quote: "「行こう」", nth: 0 }],
      decided: new Map([[1, "a"]]),
      before: "",
      after: "",
    };
    const requests = voiceCastStageRequests(chunk, people);
    expect(requests.speaker).toBeUndefined();
    expect(requests.emotion.userPrompt).toContain("〔1〕「行こう」");
    const open = voiceCastStageRequests({ ...chunk, decided: new Map() }, people);
    expect(open.speaker?.userPrompt).toContain("【登場人物】");
    expect(open.speaker?.systemPrompt).not.toBe(open.emotion.systemPrompt);
  });
});

describe("P-54 版1.4：掛け合いの流れ（案 C）", () => {
  const chunk = {
    text: "〔1〕「どこへ」",
    dialogues: [{ index: 3, start: 0, end: 5, quote: "「どこへ」", nth: 0 }],
    decided: new Map<number, string>(),
    before: "",
    after: "",
  };

  test("流れを渡すと、1段目に名前の列だけを添える（確かではない参考と書く）。2段目には添えない", () => {
    const requests = voiceCastStageRequests(chunk, people, { flow: ["灯", "蓮", "不明", "灯"] });
    const prompt = requests.speaker?.userPrompt ?? "";
    expect(prompt).toContain("【前の区切りの話者の流れ】");
    expect(prompt).toContain("灯 → 蓮 → 不明 → 灯");
    expect(prompt).toContain("確かではありません");
    // 流れに合わせて当てはめさせない一言が【答え方】にもある
    expect(prompt).toMatch(/流れに合わせて[^\n]*当てはめ/);
    expect(requests.emotion.userPrompt).not.toContain("流れ");
  });

  test("流れを渡さない・空なら節を出さない（測る台本の VC_FLOW=off と同じ頼み）", () => {
    for (const options of [undefined, {}, { flow: [] }]) {
      const prompt = voiceCastStageRequests(chunk, people, options).speaker?.userPrompt ?? "";
      expect(prompt).not.toContain("【前の区切りの話者の流れ】");
      expect(prompt).not.toContain("→");
    }
    const direct = buildVoiceCastSpeakerPrompt({ text: chunk.text, count: 1, people });
    expect(direct).not.toContain("【前の区切りの話者の流れ】");
    expect(direct).not.toContain("流れも参考");
  });
});
