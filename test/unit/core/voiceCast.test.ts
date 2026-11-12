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
  voicePlanNotice,
  voicePlanUnits,
  VOICE_GAP_SWITCH_MS,
  type CastEntry,
  type CastPerson,
  type VoiceAssignmentFile,
} from "../../../src/core/voiceCast";
import { parseSpeakers } from "../../../src/core/voiceEngine";
import { FAKE_SPEAKERS, FAKE_VOICEVOX_SPEAKERS } from "../support/fakeVoiceEngine";

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
    const text = "地の文だけ。\n// メモ「ここ」\n「行こう」と灯は言った。\n　「ああ」と蓮は答えた。";
    const chunks = castChunksOf(text, 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("地の文だけ。\n〔1〕「行こう」と灯は言った。\n　〔2〕「ああ」と蓮は答えた。");
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

  test("uuid とスタイルの名前で引き直す（ID が変わっても同じ声）。同じエンジンの印なら、無ければ ID", () => {
    const tagged = { ...mai, engine: "aivisspeech" as const };
    expect(resolveVoiceRef({ ...tagged, styleId: 1 }, speakers, "aivisspeech")).toBe(888753760);
    expect(resolveVoiceRef({ ...tagged, speakerUuid: "x", styleName: "x" }, speakers, "aivisspeech")).toBe(888753760);
    expect(
      resolveVoiceRef({ ...tagged, speakerUuid: "x", styleName: "x", styleId: 5 }, speakers, "aivisspeech")
    ).toBeUndefined();
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
      engine: "aivisspeech",
      names: new Map([["c-akari", "灯"]]),
    })?.units;
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
      engine: "aivisspeech",
    })?.units;
    expect(units?.[0].styleId).toBe(888753760);
    expect(
      voicePlanUnits({
        sentences,
        dialogues: [],
        cast: [],
        assignment: { version: 1, characters: {} },
        speakers: [],
        engine: "aivisspeech",
      })
    ).toBeUndefined();
  });
});

describe("一覧にいない人物の台詞（役名だけの人物）", () => {
  test("話者の欄に指示の言葉（役名・兵士・一覧にいない人物・会話の相手）が入って返ったら捨てて数える", () => {
    const { guesses, dropped } = validateCastItems(
      [
        { number: 1, speaker: "役名", emotion: "平静", intensity: "中" },
        { number: 1, speaker: "兵士", emotion: "平静", intensity: "中" },
        { number: 1, speaker: "一覧にいない人物", emotion: "平静", intensity: "中" },
        { number: 1, speaker: "会話の相手", emotion: "平静", intensity: "中" },
        { number: 1, speaker: "直前の話者", emotion: "平静", intensity: "中" },
        { number: 2, speaker: "不明", emotion: "平静", intensity: "中" },
      ],
      2,
      people
    );
    expect([...guesses.keys()]).toEqual([2]);
    expect(guesses.get(2)?.speakerId).toBeNull();
    expect(countDropReasons(dropped)).toEqual({ 話者が指示の言葉のまま: 5 });
  });

  test("一覧に本当に「兵士」という人物がいれば、指示の言葉としては捨てない", () => {
    const withSoldier: CastPerson[] = [
      ...people,
      { id: "c-soldier", name: "兵士", aliases: [], speechStyle: null },
    ];
    const { guesses, dropped } = validateCastItems(
      [{ number: 1, speaker: "兵士", emotion: "平静", intensity: "中" }],
      1,
      withSoldier
    );
    expect(dropped).toEqual([]);
    expect(guesses.get(1)?.speakerId).toBe("c-soldier");
  });

  test("不明の台詞は、台詞の既定の声で読む（人物の声にしない）", () => {
    const speakers = parseSpeakers(FAKE_SPEAKERS);
    const text = "「止まれ」";
    const sentences = buildReadingPlan(text, "curly", [], { splitDialogue: true });
    const kanon = {
      speakerUuid: "uuid-kanon",
      speakerName: "花音",
      styleName: "ノーマル",
      styleId: 1325133120,
    };
    const units = voicePlanUnits({
      sentences,
      dialogues: castDialogues(text),
      cast: [{ ...entry("「止まれ」", 0, "ai"), speakerId: null, speakerName: null }],
      assignment: { version: 1, narrator: kanon, dialogueDefault: kanon, characters: {} },
      speakers,
      engine: "aivisspeech",
    })?.units;
    expect(units?.map((u) => [u.styleId, u.who])).toEqual([[1325133120, "台詞"]]);
  });
});

describe("声の割り当てのエンジンの印（0.146.0）", () => {
  const speakers = parseSpeakers(FAKE_SPEAKERS);
  const mai = { speakerUuid: "uuid-mai", speakerName: "まい", styleName: "ノーマル", styleId: 888753760 };

  test("違うエンジンの声は、番号が同じでも引かない（別の声で黙って読まない）", () => {
    // VOICEVOX の声として選んだ番号が、AivisSpeech の一覧の別の話者の番号と重なる場合
    const other = { speakerUuid: "uuid-zundamon", speakerName: "ずんだもん", styleName: "ノーマル", styleId: 888753760 };
    expect(resolveVoiceRef({ ...other, engine: "voicevox" }, speakers, "aivisspeech")).toBeUndefined();
    // uuid とスタイル名が合っていても、印が違えば引かない
    expect(resolveVoiceRef({ ...mai, engine: "voicevox" }, speakers, "aivisspeech")).toBeUndefined();
  });

  test("印の無い前の版の声は、uuid とスタイル名で引けたときだけ使う（番号で探し直さない）", () => {
    expect(resolveVoiceRef({ ...mai, styleId: 1 }, speakers, "aivisspeech")).toBe(888753760);
    expect(
      resolveVoiceRef({ ...mai, speakerUuid: "x", styleName: "x" }, speakers, "aivisspeech")
    ).toBeUndefined();
  });

  test("同じエンジンの印の声は、uuid とスタイル名で引け、だめなら番号を見る（モデルの入れ直し）", () => {
    expect(resolveVoiceRef({ ...mai, styleId: 1, engine: "aivisspeech" }, speakers, "aivisspeech")).toBe(888753760);
    expect(
      resolveVoiceRef({ ...mai, speakerUuid: "x", styleName: "x", engine: "aivisspeech" }, speakers, "aivisspeech")
    ).toBe(888753760);
  });

  test("エンジンの印を読み書きする。知らない印は直さずに止める", () => {
    const file = parseVoiceAssignment(
      JSON.stringify({ version: 1, narrator: { ...mai, engine: "voicevox" }, characters: {} })
    );
    expect(file.narrator?.engine).toBe("voicevox");
    expect(parseVoiceAssignment(JSON.stringify({ version: 1, narrator: mai })).narrator?.engine).toBeUndefined();
    expect(() =>
      parseVoiceAssignment(JSON.stringify({ version: 1, narrator: { ...mai, engine: "coeiroink" } }))
    ).toThrow(/engine/);
  });

  test("引けない声は語りの声で読み、引けなかった枠を返す（一言は読む側が1回出す）。文にはエンジンの印", () => {
    const text = "「やった」と灯は言った。";
    const sentences = buildReadingPlan(text, "curly", [], { splitDialogue: true });
    const kanon = {
      speakerUuid: "uuid-kanon",
      speakerName: "花音",
      styleName: "ノーマル",
      styleId: 1325133120,
      engine: "aivisspeech" as const,
    };
    const plan = voicePlanUnits({
      sentences,
      dialogues: castDialogues(text),
      cast: [{ ...entry("「やった」", 0, "ai"), emotion: "平静" }],
      assignment: {
        version: 1,
        narrator: kanon,
        characters: { "c-akari": { ...mai, engine: "voicevox", characterName: "灯" } },
      },
      speakers,
      engine: "aivisspeech",
      names: new Map([["c-akari", "灯"]]),
    });
    expect(plan?.units.map((u) => [u.styleId, u.engine])).toEqual([
      [1325133120, "aivisspeech"],
      [1325133120, "aivisspeech"],
    ]);
    expect(plan?.unresolved).toEqual(["灯"]);
  });
});

describe("人物ごとにエンジンを混ぜる（2段目。0.151.0）", () => {
  const aivis = parseSpeakers(FAKE_SPEAKERS);
  const voicevox = parseSpeakers(FAKE_VOICEVOX_SPEAKERS);
  const kanon = {
    speakerUuid: "uuid-kanon",
    speakerName: "花音",
    styleName: "ノーマル",
    styleId: 1325133120,
    engine: "aivisspeech" as const,
  };
  const zunda = {
    speakerUuid: "uuid-zunda",
    speakerName: "ずんだもん",
    styleName: "ノーマル",
    styleId: 3,
    engine: "voicevox" as const,
  };
  const text = "「やった」と灯は言った。\n「誰だ」";
  const sentences = buildReadingPlan(text, "curly", [], { splitDialogue: true });
  const assignment: VoiceAssignmentFile = {
    version: 1,
    narrator: kanon,
    characters: { "c-akari": { ...zunda, characterName: "灯" } },
  };

  test("人物に割り当てた声は、その声の印のエンジンで読む（語りは AivisSpeech・灯は VOICEVOX）。感情のスタイルもその声のエンジンの一覧から選ぶ", () => {
    const plan = voicePlanUnits({
      sentences,
      dialogues: castDialogues(text),
      cast: [entry("「やった」", 0, "ai")],
      assignment,
      speakers: aivis,
      engine: "aivisspeech",
      others: new Map([["voicevox", voicevox]]),
      names: new Map([["c-akari", "灯"]]),
    });
    expect(plan?.units.map((u) => [u.speech, u.engine, u.styleId, u.styled, u.who])).toEqual([
      // 喜び → ずんだもんの「あまあま」（VOICEVOX の番号 1）
      ["「やった」", "voicevox", 1, true, "灯"],
      ["と灯は言った。", "aivisspeech", 1325133120, false, "語り"],
      // 台詞の既定が無いので語りの声（AivisSpeech）
      ["「誰だ」", "aivisspeech", 1325133120, false, "台詞"],
    ]);
    expect(plan?.unresolved).toEqual([]);
    expect(plan?.down).toEqual([]);
  });

  test("語り手も、選んだ声の印のエンジンで読む（［声］が AivisSpeech でも VOICEVOX の語り手は VOICEVOX）", () => {
    const plan = voicePlanUnits({
      sentences: buildReadingPlan("地の文。", "curly", [], { splitDialogue: true }),
      dialogues: [],
      cast: [],
      assignment: { version: 1, narrator: zunda, characters: {} },
      speakers: aivis,
      engine: "aivisspeech",
      others: new Map([["voicevox", voicevox]]),
    });
    expect(plan?.units.map((u) => [u.engine, u.styleId])).toEqual([["voicevox", 3]]);
  });

  test("印の無い前の版の声と、割り当てていない枠は［声］のエンジンで読む", () => {
    const plan = voicePlanUnits({
      sentences: buildReadingPlan("地の文。\n「誰だ」", "curly", [], { splitDialogue: true }),
      dialogues: castDialogues("地の文。\n「誰だ」"),
      cast: [],
      assignment: {
        version: 1,
        dialogueDefault: { speakerUuid: "uuid-zunda", speakerName: "ずんだもん", styleName: "ノーマル", styleId: 3 },
        characters: {},
      },
      speakers: voicevox,
      engine: "voicevox",
      others: new Map([["aivisspeech", aivis]]),
    });
    expect(plan?.units.map((u) => [u.engine, u.styleId])).toEqual([
      ["voicevox", 3],
      ["voicevox", 3],
    ]);
  });

  test("届かないエンジンの声は、代わりの声（台詞の既定か語り）で読み、届かないエンジンと枠を返す", () => {
    const plan = voicePlanUnits({
      sentences,
      dialogues: castDialogues(text),
      cast: [entry("「やった」", 0, "ai")],
      assignment,
      speakers: aivis,
      engine: "aivisspeech",
      downEngines: new Set(["voicevox"]),
      names: new Map([["c-akari", "灯"]]),
    });
    expect(plan?.units.map((u) => [u.engine, u.who])).toEqual([
      ["aivisspeech", "灯"],
      ["aivisspeech", "語り"],
      ["aivisspeech", "台詞"],
    ]);
    // 灯の台詞は語りの声（花音）の「喜び」に近いスタイルが無いので花音／ノーマルのまま
    expect(plan?.units[0].styleId).toBe(1325133120);
    expect(plan?.down).toEqual([{ engine: "voicevox", slots: ["灯"] }]);
    expect(plan?.unresolved).toEqual([]);
    const notice = voicePlanNotice(plan!, new Map([["voicevox", "unreachable"]]));
    expect(notice).toBe(
      "VOICEVOX に繋がらないので、灯 の声は代わりの声（台詞の既定か語りの声）で読みます。" +
        "VOICEVOX を起動してからもう一度押すと、割り当てた声で読みます。"
    );
  });

  test("エンジンには届いたが一覧に無い声は「見つからない」として、そのエンジンの名前で返す", () => {
    const gone = { ...zunda, speakerUuid: "uuid-gone", styleName: "消えた", styleId: 999 };
    const plan = voicePlanUnits({
      sentences,
      dialogues: castDialogues(text),
      cast: [entry("「やった」", 0, "ai")],
      assignment: { ...assignment, characters: { "c-akari": { ...gone, characterName: "灯" } } },
      speakers: aivis,
      engine: "aivisspeech",
      others: new Map([["voicevox", voicevox]]),
      names: new Map([["c-akari", "灯"]]),
    });
    expect(plan?.missing).toEqual([{ engine: "voicevox", slots: ["灯"] }]);
    expect(plan?.unresolved).toEqual(["灯"]);
    expect(voicePlanNotice(plan!)).toContain("割り当てた声のうち 灯 の声が VOICEVOX に見つからないので");
  });
});
