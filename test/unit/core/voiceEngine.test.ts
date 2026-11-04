import { afterEach, describe, expect, test } from "vitest";
import {
  applyVoiceParams,
  bytesToBase64,
  engineHostOutsideThisPc,
  normalizeEngineUrl,
  parseSpeakers,
  pickStyleForEmotion,
  SynthesisCache,
  synthesisKey,
  VoiceEngineClient,
  VoiceEngineError,
  voiceEngineNextStep,
  voiceParamsFor,
} from "../../../src/core/voiceEngine";
import { FAKE_SPEAKERS, startFakeVoiceEngine, type FakeEngine } from "../support/fakeVoiceEngine";

/**
 * 手元の音声合成エンジン（AivisSpeech／VOICEVOX）との口（設計書6.42.3）。
 * 本物のエンジンは動かさず、テストの中で立てる偽のエンジンへ向ける。
 */

const speakers = parseSpeakers(FAKE_SPEAKERS);

describe("話者の一覧を読む", () => {
  test("話し声のスタイルだけを残す（歌は落とす）", () => {
    expect(speakers.map((s) => [s.name, s.uuid, s.styles.map((t) => t.name)])).toEqual([
      ["まい", "uuid-mai", ["ノーマル", "上機嫌", "怒り・悲しみ"]],
      ["花音", "uuid-kanon", ["ノーマル", "ささやき"]],
    ]);
  });

  test("形の崩れた話者は落として続ける。一覧が配列でなければ投げる", () => {
    expect(
      parseSpeakers([{ name: 1 }, { name: "a", styles: [{ name: "x", id: "1" }] }, ...FAKE_SPEAKERS])
    ).toHaveLength(2);
    expect(() => parseSpeakers({ speakers: [] })).toThrow(VoiceEngineError);
  });
});

describe("接続先を整える", () => {
  test("http と https だけを受け、末尾の / を落とす", () => {
    expect(normalizeEngineUrl(" http://127.0.0.1:10101/ ")).toBe("http://127.0.0.1:10101");
    expect(normalizeEngineUrl("http://localhost:50021")).toBe("http://localhost:50021");
    expect(normalizeEngineUrl("file:///etc/passwd")).toBeUndefined();
    expect(normalizeEngineUrl("")).toBeUndefined();
    expect(normalizeEngineUrl("127.0.0.1:10101")).toBeUndefined();
  });
});

describe("この PC の外の宛先かを見分ける", () => {
  test("127.0.0.1・localhost・::1 はこの PC。ほかのホストは外として名前を返す", () => {
    expect(engineHostOutsideThisPc("http://127.0.0.1:10101")).toBeUndefined();
    expect(engineHostOutsideThisPc("http://localhost:50021")).toBeUndefined();
    expect(engineHostOutsideThisPc("http://LOCALHOST:50021")).toBeUndefined();
    expect(engineHostOutsideThisPc("http://[::1]:10101")).toBeUndefined();
    expect(engineHostOutsideThisPc("http://192.168.0.5:10101")).toBe("192.168.0.5:10101");
    expect(engineHostOutsideThisPc("https://voice.example.com")).toBe("voice.example.com");
    // localhost に見える名前でも、別のホストなら外
    expect(engineHostOutsideThisPc("http://localhost.example.com:10101")).toBe("localhost.example.com:10101");
  });
});

describe("感情→スタイルと調子", () => {
  test("話者に感情に近いスタイルがあればそれ。調子の寄せは半分", () => {
    expect(pickStyleForEmotion(speakers, 888753760, "喜び")).toEqual({
      styleId: 888753761,
      styled: true,
    });
    // 「怒り・悲しみ」は名前に「悲しみ」を含む
    expect(pickStyleForEmotion(speakers, 888753760, "悲しみ").styleId).toBe(888753762);
    expect(pickStyleForEmotion(speakers, 1325133120, "ささやき").styleId).toBe(1325133121);
  });

  test("無ければ選んだスタイルのまま（調子だけで寄せる）。平静は切り替えない", () => {
    expect(pickStyleForEmotion(speakers, 1325133120, "喜び")).toEqual({
      styleId: 1325133120,
      styled: false,
    });
    expect(pickStyleForEmotion(speakers, 888753760, "平静").styled).toBe(false);
  });

  test("作者の上書きが表より先", () => {
    expect(
      pickStyleForEmotion(speakers, 888753760, "驚き", { 驚き: ["怒り・悲しみ"] }).styleId
    ).toBe(888753762);
  });

  test("感情ごとに調子が変わり、強さで幅が変わる。速さは列の速さを掛ける", () => {
    const calm = voiceParamsFor("平静", "中", false, 1);
    expect(calm).toMatchObject({ speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1 });
    const shout = voiceParamsFor("叫び", "強", false, 1);
    const whisper = voiceParamsFor("ささやき", "強", false, 1);
    expect(shout.volumeScale).toBeGreaterThan(1);
    expect(whisper.volumeScale).toBeLessThan(1);
    expect(voiceParamsFor("叫び", "弱", false, 1).volumeScale).toBeLessThan(shout.volumeScale);
    // スタイルが感情を持っているときは半分
    expect(voiceParamsFor("叫び", "強", true, 1).volumeScale).toBeLessThan(shout.volumeScale);
    expect(voiceParamsFor("平静", "中", false, 1.5).speedScale).toBe(1.5);
    // 範囲の外の速さは畳む
    expect(voiceParamsFor("平静", "中", false, 10).speedScale).toBe(2);
  });

  test("audio_query の答えへ当てる。知らない欄は残す", () => {
    const out = applyVoiceParams(
      { accent_phrases: [1], speedScale: 1, outputSamplingRate: 44100 },
      voiceParamsFor("喜び", "中", false, 1.2)
    );
    expect(out.accent_phrases).toEqual([1]);
    expect(out.outputSamplingRate).toBe(44100);
    expect(out.speedScale).toBeCloseTo(1.248, 3);
  });
});

describe("合成の控え", () => {
  const params = voiceParamsFor("平静", "中", false, 1);

  test("鍵は文字列・スタイル・調子・接続先のどれが違っても別", () => {
    const base = synthesisKey("http://a", 1, "文", params);
    expect(synthesisKey("http://a", 1, "文", params)).toBe(base);
    expect(synthesisKey("http://b", 1, "文", params)).not.toBe(base);
    expect(synthesisKey("http://a", 2, "文", params)).not.toBe(base);
    expect(synthesisKey("http://a", 1, "文。", params)).not.toBe(base);
    expect(synthesisKey("http://a", 1, "文", voiceParamsFor("平静", "中", false, 1.1))).not.toBe(base);
  });

  test("上限を超えたら古く使ったものから捨てる", () => {
    const cache = new SynthesisCache(2, 1000);
    cache.set("a", new Uint8Array(10));
    cache.set("b", new Uint8Array(10));
    cache.get("a");
    cache.set("c", new Uint8Array(10));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    // 大きさの上限
    cache.set("d", new Uint8Array(995));
    expect(cache.totalBytes).toBeLessThanOrEqual(1000);
    // 1つで上限を超えるものはしまわない
    cache.set("huge", new Uint8Array(2000));
    expect(cache.get("huge")).toBeUndefined();
  });

  test("画面へ渡す base64 は Buffer を使わずに作る", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("偽のエンジンと話す", () => {
  let engine: FakeEngine | undefined;
  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  test("speakers → audio_query → synthesis。調子は合成へ当てて送る", async () => {
    engine = await startFakeVoiceEngine();
    const client = new VoiceEngineClient(engine.url);
    expect((await client.speakers()).map((s) => s.name)).toEqual(["まい", "花音"]);
    const params = voiceParamsFor("怒り", "強", false, 1);
    const wav = await client.speak("「待て」", 888753760, params);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");

    const query = engine.requests.find((r) => r.path === "/audio_query");
    expect(query?.query).toEqual({ text: "「待て」", speaker: "888753760" });
    const synth = engine.requests.find((r) => r.path === "/synthesis");
    expect(synth?.query).toEqual({ speaker: "888753760" });
    expect(synth?.body).toMatchObject({ ...params, kana: "テスト" });
  });

  test("エンジンが動いていないときは unreachable。次の操作は起動の案内（原因は決め打ちしない）", async () => {
    engine = await startFakeVoiceEngine();
    const url = engine.url;
    await engine.close();
    engine = undefined;
    const error = await new VoiceEngineClient(url).speakers().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceEngineError);
    expect((error as VoiceEngineError).kind).toBe("unreachable");
    expect(voiceEngineNextStep(error as VoiceEngineError)).toContain(
      "AivisSpeech（または VOICEVOX）を起動してから、もう一度押してください"
    );
  });

  test("成功でない応答は http。本文は detail に残す（ログへ）", async () => {
    engine = await startFakeVoiceEngine({ failSynthesis: true });
    const client = new VoiceEngineClient(engine.url);
    const error = await client
      .speak("文", 1, voiceParamsFor("平静", "中", false, 1))
      .catch((e: unknown) => e);
    expect((error as VoiceEngineError).kind).toBe("http");
    expect((error as VoiceEngineError).detail).toContain("合成できません");
  });
});
