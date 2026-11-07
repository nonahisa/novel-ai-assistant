import { describe, expect, test } from "vitest";
import {
  castChunksOf,
  castDialogues,
  castGuessesForChunk,
  castSpeakersFromText,
  type CastPerson,
} from "../../../src/core/voiceCast";

/**
 * 案 A「書いてある所はコードで決める」（設計書6.42.3・P-54 版1.2）。
 *
 * 台詞のすぐ前後の地の文に話者がはっきり書いてあれば、AIに訊かずに話者を当てる。
 * **取り違えを増やさないことを、見逃しを減らすことより先にする**（2026-11-07 の指示）。
 * だから「当てない」側の試験を厚くする。
 */

const people: CastPerson[] = [
  { id: "c-akari", name: "灯", aliases: ["あかりちゃん"], speechStyle: null },
  { id: "c-ren", name: "蓮", aliases: [], speechStyle: null },
];

/** 台詞の頭の字 → 決まった人物の id（決まらなければ載らない） */
function decided(text: string, list: readonly CastPerson[] = people): Record<string, string> {
  const dialogues = castDialogues(text);
  const map = castSpeakersFromText(text, list);
  const out: Record<string, string> = {};
  for (const d of dialogues) {
    const id = map.get(d.index);
    if (id !== undefined) out[d.quote] = id;
  }
  return out;
}

describe("話者がはっきり書いてある台詞は、コードで当てる", () => {
  test("台詞の直後の「と〈名前〉は／が…」", () => {
    const text = [
      "「行こう」と灯は言った。",
      "「どこへ」と蓮が答えた。",
      "「やった！」と、灯は小さく笑った。",
      "「静かに」と蓮も囁く。",
    ].join("\n");
    expect(decided(text)).toEqual({
      "「行こう」": "c-akari",
      "「どこへ」": "c-ren",
      "「やった！」": "c-akari",
      "「静かに」": "c-ren",
    });
  });

  test("別名でも当てる（人物の資料の別名に、そのまま当たるもの）", () => {
    expect(decided("「ねえ」とあかりちゃんが言った。")).toEqual({ "「ねえ」": "c-akari" });
  });

  test("台詞の直前の行に「〈名前〉は言った」「〈名前〉が叫んだ」などがある", () => {
    const text = ["　灯は言った。", "「行こう」", "　蓮は思わず叫んだ。", "「待て」"].join("\n");
    expect(decided(text)).toEqual({ "「行こう」": "c-akari", "「待て」": "c-ren" });
  });

  test("同じ行の、台詞の前の文に書いてある（地の文と台詞を1行に続ける書き方）", () => {
    expect(decided("　蓮は笑った。「冗談だよ」")).toEqual({ "「冗談だよ」": "c-ren" });
  });

  test("行頭に名前を置く台本の書き方（灯「…」）", () => {
    expect(decided("灯「行こう」\n蓮：「ああ」")).toEqual({
      "「行こう」": "c-akari",
      "「ああ」": "c-ren",
    });
  });

  test("前置きの句のあとの「、〈名前〉は言った」（作者の作品に多い書き方）", () => {
    const text = "　無造作に積まれた皮を一瞥して、灯は言った。\n「安いね」";
    expect(decided(text)).toEqual({ "「安いね」": "c-akari" });
  });

  test("名前に敬称が付いていても同じ人物（さん・様・先生など）", () => {
    const text = "　しばらく黙っていると、灯さんが口を開いた。\n「あのね」\n「ほら」と蓮様は笑った。";
    expect(decided(text)).toEqual({ "「あのね」": "c-akari", "「ほら」": "c-ren" });
  });

  test("一覧の長い名前は、短い名前の部分一致にしない（灯里は灯ではない）", () => {
    const withAkari: CastPerson[] = [
      ...people,
      { id: "c-akari2", name: "灯里", aliases: [], speechStyle: null },
    ];
    expect(decided("「おはよう」と灯里は言った。", withAkari)).toEqual({ "「おはよう」": "c-akari2" });
    // 一覧に「灯里」がいなければ、「灯里」の「灯」には当てない
    expect(decided("「おはよう」と灯里は言った。")).toEqual({});
  });
});

describe("はっきりしない台詞は、当てずにAIへ回す", () => {
  test("同じ地の文に一覧の名前が2人以上ある", () => {
    expect(decided("「行こう」と灯は蓮に言った。")).toEqual({});
    expect(decided("「行こう」と灯が言うと、蓮は笑った。")).toEqual({});
    expect(decided("　灯は蓮を見て笑った。\n「平気」")).toEqual({});
  });

  test("一覧にいない役名（兵士・師匠）は当てない", () => {
    expect(decided("「止まれ」と兵士が叫んだ。\n「下がれ」と師匠は言った。")).toEqual({});
    // 文に一覧の名前があっても、話す主語が役名なら当てない
    expect(decided("　灯を見下ろして、兵士は言った。\n「降りろ」")).toEqual({});
  });

  test("前置きの句と主語に、別々の一覧の人物がいれば当てない", () => {
    expect(decided("　灯が意外そうに言うと、蓮は笑った。\n「だろ？」")).toEqual({});
  });

  test("直前の行が「〈名前〉は言った」でも、直後の「と…」が別の人物なら当てない", () => {
    expect(decided("　灯は言った。\n「行こう」と蓮が答えた。")).toEqual({});
  });

  test("直後の「と…」が一覧の別の人物に触れていれば、直前の行の名前を当てない", () => {
    expect(decided("　灯は言った。\n「行こう」と、蓮のほうを向く。")).toEqual({});
  });

  test("前の行に台詞があれば、その行の名前を次の台詞へ持ち越さない", () => {
    // 2行目は1行目の灯への返事かもしれない（いちばん起きやすい取り違え）
    expect(decided("「行こう」と灯は言った。\n「ああ」")).toEqual({ "「行こう」": "c-akari" });
  });

  test("続けて並んだ台詞の2つ目には、前の地の文の名前を当てない", () => {
    expect(decided("　灯は言った。\n「行こう」「ああ」")).toEqual({ "「行こう」": "c-akari" });
  });

  test("受け身（言われた）は、言った人ではない", () => {
    expect(decided("「ばか」と灯は言われた。")).toEqual({});
  });

  test("「〈名前〉に」「〈名前〉を」は話し手ではない", () => {
    expect(decided("「行こう」と灯に声をかける。")).toEqual({});
    expect(decided("　灯を見た。\n「行こう」")).toEqual({});
  });

  test("「聞いた」は、訊いたのか聞こえたのか分からないので拾わない", () => {
    expect(decided("　灯は聞いた。\n「誰？」")).toEqual({});
  });

  test("話す以外の意味にもなる動詞（続けた・返した・応えた・切り出した）では拾わない", () => {
    expect(decided("　灯は歩き続けた。\n「遠いね」")).toEqual({});
    expect(decided("　灯は本を返した。\n「ありがとう」")).toEqual({});
    expect(decided("　灯は期待に応えた。\n「やった」")).toEqual({});
    expect(decided("　灯は木を切り出した。\n「重い」")).toEqual({});
  });

  test("直前の行の名前が、話す言葉で終わっていなければ拾わない", () => {
    expect(decided("　灯は窓の外を見ていた。\n「雨だ」")).toEqual({});
    expect(decided("　灯は言った言葉を思い出していた。\n「雨だ」")).toEqual({});
  });

  test("2人が同じ別名を持っていたら、その別名では当てない", () => {
    const twins: CastPerson[] = [
      { id: "a", name: "兄", aliases: ["先輩"], speechStyle: null },
      { id: "b", name: "姉", aliases: ["先輩"], speechStyle: null },
    ];
    expect(decided("「急げ」と先輩が言った。", twins)).toEqual({});
  });

  test("シーンメモの行は地の文として見ない", () => {
    expect(decided("// 灯は言った。\n「行こう」")).toEqual({});
  });
});

describe("区切りとAIの答えを混ぜる", () => {
  const text = "「行こう」と灯は言った。\n「どこへ」\n　蓮が答えた。\n「港だ」";

  test("区切りは、コードで決めた台詞を区切りの中の番号で持つ（本文の〔番号〕はそのまま）", () => {
    const fixed = castSpeakersFromText(text, people);
    const [chunk] = castChunksOf(text, 2000, fixed);
    expect(chunk.text).toBe("〔1〕「行こう」と灯は言った。\n〔2〕「どこへ」\n　蓮が答えた。\n〔3〕「港だ」");
    expect([...chunk.decided.entries()]).toEqual([
      [1, "c-akari"],
      [3, "c-ren"],
    ]);
  });

  test("コードで決めた番号は、AIの話者を見ずにコードの話者にする。感情と強さはAIの答え", () => {
    const fixed = castSpeakersFromText(text, people);
    const [chunk] = castChunksOf(text, 2000, fixed);
    const result = castGuessesForChunk(
      [
        // 話者が決まっている台詞にAIが「不明」や一覧の外を返しても、捨てずに感情だけ使う
        { number: 1, speaker: "不明", emotion: "喜び", intensity: "強" },
        { number: 2, speaker: "灯", emotion: "驚き", intensity: "中" },
        { number: 3, speaker: "霞野まどか", emotion: "平静", intensity: "弱" },
      ],
      chunk,
      people
    );
    expect(result.dropped).toEqual([]);
    expect(result.guesses.get(1)).toEqual({ speakerId: "c-akari", emotion: "喜び", intensity: "強" });
    expect(result.guesses.get(2)?.speakerId).toBe("c-akari");
    expect(result.guesses.get(3)).toEqual({ speakerId: "c-ren", emotion: "平静", intensity: "弱" });
    expect(result.decidedByText).toBe(2);
    expect(result.disagreed).toBe(2);
  });

  test("コードで決めた番号にAIの答えが無ければ、話者だけ決めて平静・中で読む", () => {
    const fixed = castSpeakersFromText(text, people);
    const [chunk] = castChunksOf(text, 2000, fixed);
    const result = castGuessesForChunk(
      [{ number: 2, speaker: "不明", emotion: "驚き", intensity: "中" }],
      chunk,
      people
    );
    expect(result.guesses.get(1)).toEqual({ speakerId: "c-akari", emotion: "平静", intensity: "中" });
    expect(result.guesses.get(3)).toEqual({ speakerId: "c-ren", emotion: "平静", intensity: "中" });
    expect(result.calmFilled).toBe(2);
  });

  test("コードで決めた番号でも、感情が列挙の外なら捨てて数え、平静・中にする", () => {
    const fixed = castSpeakersFromText(text, people);
    const [chunk] = castChunksOf(text, 2000, fixed);
    const result = castGuessesForChunk(
      [{ number: 1, speaker: "灯", emotion: "切ない", intensity: "中" }],
      chunk,
      people
    );
    expect(result.dropped.map((d) => d.reason)).toEqual(["感情が列挙の外"]);
    expect(result.guesses.get(1)).toEqual({ speakerId: "c-akari", emotion: "平静", intensity: "中" });
  });
});
