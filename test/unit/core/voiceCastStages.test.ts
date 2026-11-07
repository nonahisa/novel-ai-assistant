import { describe, expect, test } from "vitest";
import {
  castChunksOf,
  castGuessesForStages,
  validateCastEmotions,
  validateCastSpeakers,
  type CastPerson,
} from "../../../src/core/voiceCast";

/**
 * 案 B「訊き方を2段に分ける」（設計書6.42.3・P-54 版1.3）。
 *
 * 1段目は話者だけ、2段目は感情と強さだけを訊く。検算は段ごとに分け、
 * 捨てた答えも段ごとに数える（どちらの段の頼み方を直せばよいか分かるように）。
 */

const people: CastPerson[] = [
  { id: "c-akari", name: "灯", aliases: ["あかりちゃん"], speechStyle: null },
  { id: "c-ren", name: "蓮", aliases: [], speechStyle: null },
];

describe("区切りの前後の本文（1段目の参考）", () => {
  test("前後の区切りの字を、番号を付けずに添える。シーンメモは送らない", () => {
    const text = ["地の文その一。", "// 作者のメモ", "「一」", "地の文その二。", "「二」", "終わりの地の文。"].join(
      "\n"
    );
    // 1区切りを小さくして、台詞ごとに分ける
    const chunks = castChunksOf(text, 8, undefined, { before: 100, after: 100 });
    expect(chunks.map((c) => c.text)).toEqual(["〔1〕「一」", "〔1〕「二」"]);
    expect(chunks[0].before).toBe("地の文その一。");
    expect(chunks[0].after).toBe("地の文その二。\n「二」\n終わりの地の文。");
    expect(chunks[1].before).toBe("地の文その一。\n「一」\n地の文その二。");
    expect(chunks[1].after).toBe("終わりの地の文。");
    for (const chunk of chunks) {
      expect(chunk.before + chunk.after).not.toContain("メモ");
      expect(chunk.before + chunk.after).not.toContain("〔");
    }
  });

  test("字数で切る（前は後ろから、後ろは前から）。指定が無ければ空", () => {
    const text = ["あいうえおかきくけこ", "「台詞」", "さしすせそたちつてと"].join("\n");
    const [chunk] = castChunksOf(text, 2000, undefined, { before: 4, after: 3 });
    // 区切りは1つ（本文がまるごと入る）なので、前後は無い
    expect(chunk.before).toBe("");
    expect(chunk.after).toBe("");
    const small = castChunksOf(text, 5, undefined, { before: 4, after: 3 });
    expect(small[0].before).toBe("きくけこ");
    expect(small[0].after).toBe("さしす");
    expect(castChunksOf(text, 5)[0].before).toBe("");
  });
});

describe("1段目の検算（話者だけ）", () => {
  test("名前・別名・不明を受け、通らないものは理由ごとに捨てる", () => {
    const { speakers, dropped } = validateCastSpeakers(
      [
        { number: 1, speaker: "あかりちゃん" },
        { number: 2, speaker: "不明" },
        { number: 3, speaker: "話者" },
        { number: 4, speaker: "霞野まどか" },
        { number: 9, speaker: "蓮" },
        { number: 2, speaker: "蓮" },
        "形が違う",
      ],
      4,
      people
    );
    expect([...speakers]).toEqual([
      [1, "c-akari"],
      [2, null],
    ]);
    expect(dropped.map((d) => d.reason)).toEqual([
      "話者が指示の言葉のまま",
      "話者が資料の人物に無い",
      "番号が区切りに無い",
      "同じ番号の答えが2つ目",
      "形が違う",
    ]);
  });

  test("話者を訊いていない番号（本文に書いてあった台詞）への答えは、理由を分けて捨てる", () => {
    const { speakers, dropped } = validateCastSpeakers(
      [
        { number: 1, speaker: "蓮" },
        { number: 2, speaker: "灯" },
      ],
      2,
      people,
      new Map([[1, "c-akari"]])
    );
    expect([...speakers]).toEqual([[2, "c-akari"]]);
    expect(dropped.map((d) => d.reason)).toEqual(["話者を訊いていない番号"]);
  });
});

describe("2段目の検算（感情と強さだけ）", () => {
  test("列挙の外は捨てる。話者の欄が付いて返っても見ない", () => {
    const { emotions, dropped } = validateCastEmotions(
      [
        { number: 1, emotion: "喜び", intensity: "強", speaker: "蓮" },
        { number: 2, emotion: "切ない", intensity: "中" },
        { number: 3, emotion: "平静", intensity: "とても" },
        { number: 0, emotion: "平静", intensity: "中" },
      ],
      3
    );
    expect([...emotions]).toEqual([[1, { emotion: "喜び", intensity: "強" }]]);
    expect(dropped.map((d) => d.reason)).toEqual(["感情が列挙の外", "強さが列挙の外", "番号が区切りに無い"]);
  });
});

describe("2段の答えを混ぜる", () => {
  const chunk = {
    dialogues: [1, 2, 3, 4, 5].map((i) => ({ index: i - 1, start: 0, end: 0, quote: `「${i}」`, nth: 0 })),
    decided: new Map([[1, "c-akari"]]),
  };

  test("話者はコード→1段目、感情は2段目。捨てた数は段ごとに返す", () => {
    const result = castGuessesForStages(
      {
        speakerItems: [
          { number: 1, speaker: "蓮" }, // 訊いていない番号 → 捨てる（コードの灯のまま）
          { number: 2, speaker: "蓮" },
          { number: 3, speaker: "不明" },
          { number: 4, speaker: "話者" }, // 捨てる → 話者なし
        ],
        emotionItems: [
          { number: 1, emotion: "喜び", intensity: "中" },
          { number: 2, emotion: "切ない", intensity: "中" }, // 捨てる → 蓮だけ決めて平静・中
          { number: 3, emotion: "驚き", intensity: "弱" },
          { number: 4, emotion: "怒り", intensity: "強" },
          // 5 は感情の答えが無く、話者も分からない → 推定なし
        ],
      },
      chunk,
      people
    );
    expect(Object.fromEntries(result.guesses)).toEqual({
      1: { speakerId: "c-akari", emotion: "喜び", intensity: "中" },
      2: { speakerId: "c-ren", emotion: "平静", intensity: "中" },
      3: { speakerId: null, emotion: "驚き", intensity: "弱" },
      4: { speakerId: null, emotion: "怒り", intensity: "強" },
    });
    expect(result.droppedSpeaker.map((d) => d.reason)).toEqual(["話者を訊いていない番号", "話者が指示の言葉のまま"]);
    expect(result.droppedEmotion.map((d) => d.reason)).toEqual(["感情が列挙の外"]);
    expect(result.decidedByText).toBe(1);
    expect(result.calmFilled).toBe(1);
  });

  test("1段目が全部「不明」でも、2段目の感情は使う", () => {
    const result = castGuessesForStages(
      {
        speakerItems: [2, 3, 4, 5].map((number) => ({ number, speaker: "不明" })),
        emotionItems: [1, 2, 3, 4, 5].map((number) => ({ number, emotion: "悲しみ", intensity: "中" })),
      },
      chunk,
      people
    );
    expect(result.guesses.size).toBe(5);
    expect(result.guesses.get(2)).toEqual({ speakerId: null, emotion: "悲しみ", intensity: "中" });
    expect(result.guesses.get(1)?.speakerId).toBe("c-akari");
  });

  test("1段目を呼ばなかった区切り（全部コードで決まった）は、speakerItems が無くても混ぜられる", () => {
    const all = { dialogues: chunk.dialogues.slice(0, 2), decided: new Map([[1, "c-akari"], [2, "c-ren"]]) };
    const result = castGuessesForStages(
      { emotionItems: [{ number: 1, emotion: "照れ", intensity: "弱" }] },
      all,
      people
    );
    expect(Object.fromEntries(result.guesses)).toEqual({
      1: { speakerId: "c-akari", emotion: "照れ", intensity: "弱" },
      2: { speakerId: "c-ren", emotion: "平静", intensity: "中" },
    });
    expect(result.droppedSpeaker).toEqual([]);
  });
});
