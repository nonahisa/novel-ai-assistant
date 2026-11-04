import { describe, expect, test } from "vitest";
import { buildReadingPlan } from "../../../src/core/readAloud";
import {
  castChunksOf,
  castDialogues,
  castLookup,
  countDropReasons,
  editCastEntry,
  mergeCastEntries,
  parseCastFile,
  parseCastResult,
  parseVoiceAssignment,
  resolveVoiceRef,
  validateCastItems,
  voicePlanUnits,
  VOICE_GAP_SWITCH_MS,
  type CastEntry,
  type CastPerson,
  type VoiceAssignmentFile,
} from "../../../src/core/voiceCast";
import { parseSpeakers } from "../../../src/core/voiceEngine";
import { FAKE_SPEAKERS } from "../support/fakeVoiceEngine";

/**
 * 台詞ごとの話者と感情・声の割り当て（設計書6.42.3）の純粋な部分。
 */

const people: CastPerson[] = [
  { id: "c-akari", name: "灯", aliases: ["あかりちゃん"], speechStyle: "丁寧語" },
  { id: "c-ren", name: "蓮", aliases: [], speechStyle: "ぶっきらぼう" },
];

describe("台詞を並べて区切る", () => {
  test("同じ字の台詞には何番目かを添える", () => {
    const text = "「はい」\n「いいえ」\n「はい」";
    expect(castDialogues(text).map((d) => [d.index, d.quote, d.nth])).toEqual([
      [0, "「はい」", 0],
      [1, "「いいえ」", 0],
      [2, "「はい」", 1],
    ]);
  });

  test("台詞の頭に区切りの中の番号を差し込む。シーンメモは送らない。台詞の無い区切りは送らない", () => {
    const text = "地の文だけ。\n// メモ「ここ」\n灯は「行こう」と言い、蓮は「ああ」と答えた。";
    const chunks = castChunksOf(text, 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("地の文だけ。\n灯は〔1〕「行こう」と言い、蓮は〔2〕「ああ」と答えた。");
    expect(chunks[0].dialogues.map((d) => d.quote)).toEqual(["「行こう」", "「ああ」"]);
  });

  test("番号は区切りごとに1から（前の区切りが変わっても後ろの区切りの字は変わらない）", () => {
    const text = "「一」\n" + "あ".repeat(30) + "\n「二」";
    const chunks = castChunksOf(text, 20);
    expect(chunks.map((c) => c.text)).toEqual(["〔1〕「一」", "〔1〕「二」"]);
    expect(chunks[1].dialogues[0].index).toBe(1);
  });
});

describe("AIの答えの検算", () => {
  test("番号の実在・人物名か別名・列挙の内。別名は人物へ寄せる。不明は話者なし", () => {
    const { guesses, dropped } = validateCastItems(
      [
        { number: 1, speaker: "あかりちゃん", emotion: "喜び", intensity: "強" },
        { number: 2, speaker: "不明", emotion: "平静", intensity: "中" },
        { number: 3, speaker: "蓮", emotion: "怒り", intensity: "弱" },
      ],
      3,
      people
    );
    expect(dropped).toEqual([]);
    expect(guesses.get(1)).toEqual({ speakerId: "c-akari", emotion: "喜び", intensity: "強" });
    expect(guesses.get(2)?.speakerId).toBeNull();
    expect(guesses.get(3)?.speakerId).toBe("c-ren");
  });

  test("通らないものは捨て、理由ごとに数える（指示の言葉がそのまま返ったものも）", () => {
    const { guesses, dropped } = validateCastItems(
      [
        { number: 0, speaker: "灯", emotion: "喜び", intensity: "中" },
        { number: 9, speaker: "灯", emotion: "喜び", intensity: "中" },
        { number: 1.5, speaker: "灯", emotion: "喜び", intensity: "中" },
        { number: 1, speaker: "話者", emotion: "喜び", intensity: "中" },
        { number: 1, speaker: "人物名", emotion: "喜び", intensity: "中" },
        { number: 1, speaker: "霞野まどか", emotion: "喜び", intensity: "中" },
        { number: 1, speaker: "灯", emotion: "感情", intensity: "中" },
        { number: 1, speaker: "灯", emotion: "切ない", intensity: "中" },
        { number: 1, speaker: "灯", emotion: "喜び", intensity: "強さ" },
        { number: 2, speaker: "灯", emotion: "喜び", intensity: "中" },
        { number: 2, speaker: "蓮", emotion: "怒り", intensity: "中" },
        "壊れた答え",
      ],
      2,
      people
    );
    expect([...guesses.keys()]).toEqual([2]);
    expect(guesses.get(2)?.speakerId).toBe("c-akari");
    expect(countDropReasons(dropped)).toEqual({
      番号が区切りに無い: 3,
      話者が指示の言葉のまま: 2,
      話者が資料の人物に無い: 1,
      感情が列挙の外: 2,
      強さが列挙の外: 1,
      同じ番号の答えが2つ目: 1,
      形が違う: 1,
    });
  });

  test("2人が同じ別名を持っていたら、どちらとも決めない", () => {
    const twins: CastPerson[] = [
      { id: "a", name: "兄", aliases: ["先輩"], speechStyle: null },
      { id: "b", name: "姉", aliases: ["先輩"], speechStyle: null },
    ];
    const { dropped } = validateCastItems(
      [{ number: 1, speaker: "先輩", emotion: "平静", intensity: "中" }],
      1,
      twins
    );
    expect(dropped[0].reason).toBe("話者の名前が2人に当たる");
  });

  test("答えの本文を読む（コードの柵が付いていても）。形が違えば undefined", () => {
    expect(parseCastResult('```json\n{"lines":[{"number":1}]}\n```')).toEqual([{ number: 1 }]);
    expect(parseCastResult('{"items":[]}')).toBeUndefined();
    expect(parseCastResult("ごめんなさい")).toBeUndefined();
  });
});

function entry(quote: string, nth: number, source: "ai" | "author", speakerId = "c-akari"): CastEntry {
  return {
    quote,
    nth,
    speakerId,
    speakerName: speakerId === "c-akari" ? "灯" : "蓮",
    emotion: "喜び",
    intensity: "中",
    source,
  };
}

describe("推定の結果のファイル", () => {
  test("作者が直した行は、推定し直しても残る", () => {
    const merged = mergeCastEntries(
      [entry("「はい」", 0, "author", "c-ren"), entry("「いいえ」", 0, "ai")],
      [entry("「はい」", 0, "ai"), entry("「いいえ」", 0, "ai", "c-ren")]
    );
    expect(merged).toEqual([entry("「はい」", 0, "author", "c-ren"), entry("「いいえ」", 0, "ai", "c-ren")]);
  });

  test("作者の直しは author になる（無ければ足す）", () => {
    const edited = editCastEntry([entry("「はい」", 0, "ai")], { quote: "「はい」", nth: 0 }, {
      speakerId: "c-ren",
      speakerName: "蓮",
      emotion: "怒り",
      intensity: "強",
    });
    expect(edited[0]).toMatchObject({ source: "author", speakerId: "c-ren", emotion: "怒り" });
    expect(editCastEntry([], { quote: "「新」", nth: 0 }, edited[0])).toHaveLength(1);
  });

  test("同じ字・同じ番目で引く。同じ字の推定が1つだけなら番目がずれても使う", () => {
    const dialogues = castDialogues("「はい」\n「前に足した」\n「はい」\n「独り」");
    const lookup = castLookup(
      [entry("「はい」", 0, "ai"), entry("「はい」", 1, "ai", "c-ren"), entry("「独り」", 3, "ai")],
      dialogues
    );
    expect(lookup.get(0)?.speakerId).toBe("c-akari");
    expect(lookup.get(2)?.speakerId).toBe("c-ren");
    expect(lookup.get(3)?.quote).toBe("「独り」");
    expect(lookup.has(1)).toBe(false);
  });

  test("壊れたファイルは直さずに投げる", () => {
    expect(() => parseCastFile("{")).toThrow();
    expect(() =>
      parseCastFile(JSON.stringify({ version: 1, episode: "a", entries: [{ ...entry("「a」", 0, "ai"), emotion: "切ない" }] }))
    ).toThrow(/列挙の外/);
    const ok = { version: 1, episode: "a", entries: [entry("「a」", 0, "author")] };
    expect(parseCastFile(JSON.stringify(ok)).entries).toEqual(ok.entries);
  });

  test("声の割り当ての壊れた形は投げる。感情の上書きは列挙の内だけ", () => {
    expect(() => parseVoiceAssignment(JSON.stringify({ version: 1, narrator: { styleId: 1 } }))).toThrow();
    expect(() =>
      parseVoiceAssignment(JSON.stringify({ version: 1, emotionStyles: { 切ない: ["x"] } }))
    ).toThrow(/列挙/);
    expect(
      parseVoiceAssignment(JSON.stringify({ version: 1, emotionStyles: { 喜び: ["あまあま"] } })).emotionStyles
    ).toEqual({ 喜び: ["あまあま"] });
  });
});

describe("文ごとの声", () => {
  const speakers = parseSpeakers(FAKE_SPEAKERS);
  const mai = { speakerUuid: "uuid-mai", speakerName: "まい", styleName: "ノーマル", styleId: 888753760 };
  const kanon = {
    speakerUuid: "uuid-kanon",
    speakerName: "花音",
    styleName: "ノーマル",
    styleId: 1325133120,
  };

  test("uuid とスタイルの名前で引き直す（ID が変わっても同じ声）。無ければ ID", () => {
    expect(resolveVoiceRef({ ...mai, styleId: 1 }, speakers)).toBe(888753760);
    expect(resolveVoiceRef({ ...mai, speakerUuid: "x", styleName: "x" }, speakers)).toBe(888753760);
    expect(resolveVoiceRef({ ...mai, speakerUuid: "x", styleName: "x", styleId: 5 }, speakers)).toBeUndefined();
  });

  test("語り手・人物・台詞の既定の声。感情でスタイルが変わり、推定の無い台詞は既定の声で平静", () => {
    const text = "「やった」と灯は言った。\n「誰だ」";
    const sentences = buildReadingPlan(text, "curly", [], { splitDialogue: true });
    const assignment: VoiceAssignmentFile = {
      version: 1,
      narrator: kanon,
      dialogueDefault: kanon,
      characters: { "c-akari": { ...mai, characterName: "灯" } },
    };
    const units = voicePlanUnits({
      sentences,
      dialogues: castDialogues(text),
      cast: [entry("「やった」", 0, "ai")],
      assignment,
      speakers,
      names: new Map([["c-akari", "灯"]]),
    });
    expect(units?.map((u) => [u.speech, u.styleId, u.emotion, u.styled, u.who])).toEqual([
      ["「やった」", 888753761, "喜び", true, "灯"],
      ["と灯は言った。", 1325133120, "平静", false, "語り"],
      ["「誰だ」", 1325133120, "平静", false, "台詞"],
    ]);
    expect(units?.[0].gapMs).toBe(0);
    expect(units?.[1].gapMs).toBe(VOICE_GAP_SWITCH_MS);
  });

  test("割り当てが無ければエンジンの最初の声。話者が1人もいなければ読めない", () => {
    const sentences = buildReadingPlan("地の文。", "curly", [], { splitDialogue: true });
    const units = voicePlanUnits({
      sentences,
      dialogues: [],
      cast: [],
      assignment: { version: 1, characters: {} },
      speakers,
    });
    expect(units?.[0].styleId).toBe(888753760);
    expect(
      voicePlanUnits({ sentences, dialogues: [], cast: [], assignment: { version: 1, characters: {} }, speakers: [] })
    ).toBeUndefined();
  });
});
