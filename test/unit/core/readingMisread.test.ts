import { afterEach, describe, expect, it } from "vitest";
import { VoiceEngineClient, VoiceEngineError } from "../../../src/core/voiceEngine";
import { buildReadingPlan, sentenceSpeechWith } from "../../../src/core/readAloud";
import {
  collectKnownReadings,
  compareKana,
  findMisreadCandidates,
  judgeMisreads,
  MisreadAnswerError,
  misreadWindow,
  normalizeKana,
  type KnownReadingEpisode,
} from "../../../src/core/readingMisread";
import { startFakeVoiceEngine, type FakeEngine } from "../support/fakeVoiceEngine";

/**
 * 読み間違いの見込み（設計書6.42.5）。偽のエンジンは語ごとの読みを返す（表に無い漢字は読めない）。
 * 見逃し（読み違えているのに出ない）と誤検出（読めているのに出る）の両方を見る
 */

const STYLE = 888753760;
let engine: FakeEngine | undefined;

afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

async function queryWith(readings: Record<string, string>) {
  engine = await startFakeVoiceEngine({ readings });
  const client = new VoiceEngineClient(engine.url);
  return (speech: string) => client.audioQuery(speech, STYLE);
}

function episode(text: string, label = "第1話", dictionary: KnownReadingEpisode["dictionary"] = []): KnownReadingEpisode {
  return { label, text, notation: "curly", dictionary };
}

function audioQueryTexts(): string[] {
  return (engine?.requests ?? []).filter((r) => r.path === "/audio_query").map((r) => r.query.text);
}

describe("ルビを1回だけ振った語の2回目", () => {
  const text = "　{灯|あかり}が笑った。\n　灯は走った。";

  it("エンジンが別の読みで読むと、行が出る（エンジンの読みと正しい読みが分かる）", async () => {
    const known = collectKnownReadings([episode(text)], []);
    const { candidates } = findMisreadCandidates(text, "curly", [], known);
    expect(candidates.map((c) => [c.word, c.line])).toEqual([["灯", 2]]);
    const found = await judgeMisreads(candidates, await queryWith({ 灯: "ヒ", 走: "ハシ" }));
    expect(found).toHaveLength(1);
    expect(found[0].engineReading).toBe("ヒ");
    expect(found[0].expected.reading).toBe("あかり");
    expect(found[0].expected.source).toEqual({ kind: "ruby", episode: "第1話" });
  });

  it("エンジンが正しく読むと、出ない", async () => {
    const known = collectKnownReadings([episode(text)], []);
    const { candidates } = findMisreadCandidates(text, "curly", [], known);
    const found = await judgeMisreads(candidates, await queryWith({ 灯: "アカリ", 走: "ハシ" }));
    expect(found).toEqual([]);
  });

  it("ルビそのもの（記法の内側）は問わない", () => {
    const only = "　{灯|あかり}が笑った。";
    const known = collectKnownReadings([episode(only)], []);
    expect(findMisreadCandidates(only, "curly", [], known).candidates).toEqual([]);
  });
});

describe("置き換え済みの所", () => {
  it("読みの範囲（辞書・設定資料の読み）で置き換えた所は問わない", () => {
    const text = "　{灯|あかり}が笑った。\n　灯は走った。";
    const at = text.lastIndexOf("灯");
    const known = collectKnownReadings([episode(text)], []);
    const spans = [{ start: at, end: at + 1, reading: "あかり" }];
    expect(findMisreadCandidates(text, "curly", spans, known).candidates).toEqual([]);
  });

  it("熟語の中（前後が漢字）は拾わない", () => {
    const text = "　{灯|あかり}が来た。\n　街灯が光る。";
    const known = collectKnownReadings([episode(text)], []);
    expect(findMisreadCandidates(text, "curly", [], known).candidates).toEqual([]);
  });
});

describe("読みが2つある語（一日：ついたち／いちにち）", () => {
  const first = "　{一日|ついたち}に会う。";
  const second = "　長い一日だった。";
  const episodes = [
    episode(first, "第1話"),
    episode(second, "第2話", [{ word: "一日", quote: "長い一日", reading: "いちにち", source: "author" }]),
  ];

  it("どちらかの読みで送る文と同じになれば、読めている", async () => {
    const known = collectKnownReadings(episodes, []);
    expect(known.get("一日")?.map((k) => k.reading)).toEqual(["ついたち", "いちにち"]);
    const { candidates } = findMisreadCandidates(second, "curly", [], known);
    expect(candidates).toHaveLength(1);
    expect(await judgeMisreads(candidates, await queryWith({ 一日: "イチニチ", 長: "ナガ" }))).toEqual([]);
  });

  it("どの読みとも違えば出る（正しい読みは最初の出どころ）", async () => {
    const known = collectKnownReadings(episodes, []);
    const { candidates } = findMisreadCandidates(second, "curly", [], known);
    const found = await judgeMisreads(candidates, await queryWith({ 一日: "ヒトヒ", 長: "ナガ" }));
    expect(found).toHaveLength(1);
    expect(found[0].engineReading).toBe("ヒトヒ");
    expect(found[0].expected.reading).toBe("ついたち");
  });
});

describe("かなのならし", () => {
  it("ヲ・ヂ・ヅ、長音と前の母音の重ね、オ段のウ・エ段のイ、休止と句読点を同じに扱う", () => {
    expect(compareKana("トーキョー、ヲ", "トウキョウオ").same).toBe(true);
    expect(compareKana("セーカツ", "セイカツ").same).toBe(true);
    expect(compareKana("カーサン", "カアサン").same).toBe(true);
    expect(compareKana("ハナヂ。ツヅク", "はなじつずく").same).toBe(true);
    expect(compareKana("アカリ", "アカル").same).toBe(false);
  });

  it("違いはならす前の字で返し、小書きの字の手前で切らない", () => {
    expect(compareKana("キョウハヒガ", "キョウハアカリガ").engineReading).toBe("ヒ");
    expect(compareKana("キャク", "キョク").engineReading).toBe("キャ");
    expect(normalizeKana("ア、イ").raw).toEqual(["ア", "イ"]);
  });
});

describe("エンジンへの頼み", () => {
  it("同じ文は2回問わない（1文に語が2つあっても、送る文は1回）", async () => {
    const text = "　{灯|あかり}と{恵|めぐみ}。\n　灯は恵と話した。";
    const known = collectKnownReadings([episode(text)], []);
    const { candidates } = findMisreadCandidates(text, "curly", [], known);
    expect(candidates.map((c) => c.word)).toEqual(["灯", "恵"]);
    await judgeMisreads(candidates, await queryWith({ 灯: "ヒ", 恵: "ケイ", 話: "ハナ" }));
    const sent = audioQueryTexts();
    expect(sent.filter((t) => t === "灯は恵と話した。")).toHaveLength(1);
    expect(new Set(sent).size).toBe(sent.length);
  });

  it("エンジンが起きていなければ、調べずに投げる（呼ぶ側が理由を出す）", async () => {
    const text = "　{灯|あかり}が来た。\n　灯が来た。";
    const known = collectKnownReadings([episode(text)], []);
    const { candidates } = findMisreadCandidates(text, "curly", [], known);
    const client = new VoiceEngineClient("http://127.0.0.1:9");
    const failed = await judgeMisreads(candidates, (s) => client.audioQuery(s, STYLE)).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(VoiceEngineError);
    expect((failed as VoiceEngineError).kind).toBe("unreachable");
  });

  it("答えにモーラの並びが無ければ、形が読めないとして投げる", async () => {
    const text = "　{灯|あかり}が来た。\n　灯が来た。";
    const known = collectKnownReadings([episode(text)], []);
    const { candidates } = findMisreadCandidates(text, "curly", [], known);
    engine = await startFakeVoiceEngine({ brokenAudioQuery: true });
    const client = new VoiceEngineClient(engine.url);
    await expect(judgeMisreads(candidates, (s) => client.audioQuery(s, STYLE))).rejects.toBeInstanceOf(
      MisreadAnswerError
    );
  });
});

describe("読みを集める", () => {
  it("傍点の代用（《・・》）とメモの行のルビは読みにしない。設定資料の1字の名前は入れる", () => {
    const text = "　｜強調《・・》した。\n// {港|みなと}\n　港へ行く。";
    const known = collectKnownReadings(
      [{ label: "第1話", text, notation: "site", dictionary: [] }],
      [{ surface: "恵", reading: "めぐみ" }]
    );
    expect([...known.keys()]).toEqual(["恵"]);
  });

  it("消した辞書の項目（墓標）は使わない", () => {
    const known = collectKnownReadings(
      [episode("　港。", "第1話", [{ word: "港", quote: "港。", reading: "みなと", source: "author", removed: true }])],
      []
    );
    expect(known.size).toBe(0);
  });
});

describe("送る文の写しを作り直す", () => {
  it("読みを足さなければ、計画の文と同じ写しになる", () => {
    const text = "　{灯|あかり}が「行こう」と言った。——灯は頷く。\n// メモ\n　｜恵《めぐみ》";
    const spans = [{ start: text.indexOf("頷"), end: text.indexOf("頷") + 1, reading: "うなず" }];
    const plan = buildReadingPlan(text, "curly", spans, { splitDialogue: true });
    for (const sentence of plan) {
      expect(sentenceSpeechWith(text, sentence, "curly", spans)).toBe(sentence.speech);
    }
  });
});

describe("行の原文（窓）", () => {
  it("記法を含まず、語がちょうど1回", () => {
    const text = "　{灯|あかり}と灯が灯す。";
    const at = text.indexOf("と灯") + 1;
    const window = misreadWindow(text, at, at + 1, "curly");
    expect(window).not.toMatch(/[{}|]/);
    expect(window.split("灯").length - 1).toBe(1);
    expect(window.startsWith("と灯")).toBe(true);
  });
});
