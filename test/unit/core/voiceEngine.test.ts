import { afterEach, describe, expect, test } from "vitest";
import {
  applyVoiceParams,
  bytesToBase64,
  describeVoiceAdjust,
  engineHostOutsideThisPc,
  parseVoiceAdjust,
  VOICE_ADJUST_PRESETS,
  presetsForEngine,
  VOICE_ADJUST_STEPS,
  isNormalStyleName,
  missingEmotionStyleNotice,
  missingEmotionStyles,
  normalizeEngineUrl,
  parseSpeakers,
  pickNormalStyle,
  pickStyleForEmotion,
  styleEmotionOf,
  SynthesisCache,
  synthesisKey,
  voiceChoiceName,
  voiceChoiceRows,
  VoiceEngineClient,
  VoiceEngineError,
  voiceEngineNextStep,
  voiceEngineDownPrompt,
  voiceParamsFor,
  VOICE_EMOTIONS,
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
    // **音量は上げない**（2026-11-07 作者の答え A）。エンジンは音の山を上限いっぱいで返すので、
    // 上げると波形が振り切れて割れる（1.15倍で65点・1.375倍で294点。0.9倍で0点）
    expect(shout.volumeScale).toBe(1);
    for (const emotion of VOICE_EMOTIONS) {
      for (const intensity of ["弱", "中", "強"] as const) {
        expect(voiceParamsFor(emotion, intensity, false, 1).volumeScale).toBeLessThanOrEqual(1);
      }
    }
    expect(whisper.volumeScale).toBeLessThan(1);
    // 強さは抑揚で出す
    expect(shout.intonationScale).toBeGreaterThan(voiceParamsFor("叫び", "弱", false, 1).intonationScale);
    // スタイルが感情を持っているときは半分
    expect(voiceParamsFor("叫び", "強", true, 1).intonationScale).toBeLessThan(shout.intonationScale);
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

describe("エンジンに届かなかったときの窓（2026-11-07 作者の実機確認）", () => {
  test("画面の真ん中に出す窓の文と、次の操作のボタン1つ（閉じるは VS Code が添える）", () => {
    const prompt = voiceEngineDownPrompt();
    expect(prompt.message).toContain("音声合成のエンジンに繋がりませんでした");
    expect(prompt.detail).toContain("AivisSpeech（または VOICEVOX）を起動してから");
    expect(prompt.useOsVoice).toBe("OSの声で読む");
  });

  test("読む道の窓は、引数を付けても付けなくても同じ（原稿エディターの［▶ 読む］）", () => {
    expect(voiceEngineDownPrompt("read")).toEqual(voiceEngineDownPrompt());
    expect(voiceEngineDownPrompt("read").detail).toContain("［▶ 読む］");
  });

  test("割り当てと書き出しの窓は、同じ見出しで、［OSの声で読む］を付けず、その道に合う文にする", () => {
    const read = voiceEngineDownPrompt("read");
    for (const route of ["assign", "export"] as const) {
      const prompt = voiceEngineDownPrompt(route);
      expect(prompt.message).toBe(read.message);
      expect(prompt.detail).toContain("AivisSpeech（または VOICEVOX）を起動してから");
      // 押せないボタンの名前を文に書かない
      expect(prompt.detail).not.toContain("［OSの声で読む］");
      expect("useOsVoice" in prompt).toBe(false);
    }
    expect(voiceEngineDownPrompt("assign").detail).toContain("［声の割り当て］");
    expect(voiceEngineDownPrompt("export").detail).toContain("［音声に書き出す］");
    // 書き出しは途中のファイルを残さない。窓でもそれを言う
    expect(voiceEngineDownPrompt("export").detail).toContain("ファイルは作っていません");
  });
});

describe("英語の名前のスタイルも感情で選ぶ（2026-11-07 作者の答え）", () => {
  // AivisSpeech の話者には、スタイルの名前が英語のもの（Shout・Surprise など）がある
  const english = [
    {
      name: "英語の話者",
      speaker_uuid: "en-1",
      styles: [
        { name: "Normal", id: 100 },
        { name: "Happy", id: 101 },
        { name: "SURPRISE", id: 102 },
        { name: "shout", id: 103 },
        { name: "Whisper", id: 104 },
        { name: "Sad", id: 105 },
      ],
    },
  ];
  const speakers = parseSpeakers(english);

  test("英語の名前に当たる。大文字と小文字は区別しない", () => {
    expect(pickStyleForEmotion(speakers, 100, "喜び")).toEqual({ styleId: 101, styled: true });
    expect(pickStyleForEmotion(speakers, 100, "驚き").styleId).toBe(102);
    expect(pickStyleForEmotion(speakers, 100, "叫び").styleId).toBe(103);
    expect(pickStyleForEmotion(speakers, 100, "ささやき").styleId).toBe(104);
    expect(pickStyleForEmotion(speakers, 100, "悲しみ").styleId).toBe(105);
  });

  test("平静は選んだスタイルのまま", () => {
    expect(pickStyleForEmotion(speakers, 100, "平静")).toEqual({ styleId: 100, styled: false });
  });
});

describe("悲しみに「せつなめ」「切なげ」も当てる（0.141.1。作者の答え「足す」）", () => {
  // AivisSpeech の話者 まお・コハク は、悲しみに当たるスタイルの名前が「せつなめ」
  const sorrowful = parseSpeakers([
    {
      name: "まお",
      speaker_uuid: "mao-1",
      styles: [
        { name: "ノーマル", id: 200 },
        { name: "あまあま", id: 201 },
        { name: "せつなめ", id: 202 },
      ],
    },
    {
      name: "漢字の話者",
      speaker_uuid: "kanji-1",
      styles: [
        { name: "ノーマル", id: 300 },
        { name: "切なげ", id: 301 },
      ],
    },
  ]);

  test("「せつなめ」「切なげ」のスタイルが悲しみに選ばれる", () => {
    expect(pickStyleForEmotion(sorrowful, 200, "悲しみ")).toEqual({ styleId: 202, styled: true });
    expect(pickStyleForEmotion(sorrowful, 300, "悲しみ")).toEqual({ styleId: 301, styled: true });
  });

  test("「悲しみ」の名のスタイルがあれば、そちらが先（足した候補は後ろ）", () => {
    expect(pickStyleForEmotion(speakers, 888753760, "悲しみ").styleId).toBe(888753762);
  });
});

describe("VOICEVOX 0.26 の話者の一覧（2026-11-08 作者の実機）", () => {
  // VOICEVOX 0.26.1 は、話す声のスタイルの type を "streaming_talk" で返す（44人すべて）。
  // "talk" だけを受けていたので話者が0人になり、「話者が1人も見つかりませんでした」と出ていた
  test("type が streaming_talk の声も、話す声として読む。歌の声は外す", () => {
    const speakers = parseSpeakers([
      {
        name: "四国めたん",
        speaker_uuid: "7ffcb7ce-00ec-4bdc-82cd-45a8889e43ff",
        styles: [
          { name: "ノーマル", id: 2, type: "streaming_talk" },
          { name: "あまあま", id: 0, type: "streaming_talk" },
        ],
      },
      { name: "波音リツ", speaker_uuid: "r", styles: [{ name: "ノーマル", id: 6000, type: "sing" }] },
      { name: "古い版", speaker_uuid: "o", styles: [{ name: "ノーマル", id: 1, type: "talk" }, { name: "型なし", id: 3 }] },
    ]);
    expect(speakers.map((s) => s.name)).toEqual(["四国めたん", "古い版"]);
    expect(speakers[0]?.styles.map((s) => s.id)).toEqual([2, 0]);
    expect(speakers[1]?.styles.map((s) => s.id)).toEqual([1, 3]);
  });

  test("設定の接続先の前後の空白は取り除く", () => {
    expect(normalizeEngineUrl("http://127.0.0.1:50021 ")).toBe("http://127.0.0.1:50021");
  });
});

/**
 * 作者の VOICEVOX 0.26.1・AivisSpeech 1.1.0-dev のスタイル名（0.151.1。作者の答え 2026-11-13「スタイル名を足す」
 * 「平静の台詞は同じ話者の『ノーマル』で読む」）。再現：青山龍星の「かなしみ」に悲しみの台詞が当たらず、
 * 作者が選んだ「喜び」の声のまま読んでいた（作品の記録と VOICEVOX の /speakers で確かめた）。
 */
describe("作者のエンジンのスタイル名に当たる（0.151.1）", () => {
  const speakers = parseSpeakers([
    {
      name: "青山龍星",
      speaker_uuid: "uuid-ryusei",
      styles: [
        { name: "ノーマル", id: 13 },
        { name: "熱血", id: 81 },
        { name: "不機嫌", id: 82 },
        { name: "喜び", id: 83 },
        { name: "しっとり", id: 84 },
        { name: "かなしみ", id: 85 },
        { name: "囁き", id: 86 },
      ],
    },
    {
      name: "白上虎太郎",
      speaker_uuid: "uuid-kotaro",
      styles: [
        { name: "ふつう", id: 12 },
        { name: "わーい", id: 32 },
        { name: "びくびく", id: 33 },
        { name: "おこ", id: 34 },
        { name: "びえーん", id: 35 },
      ],
    },
    {
      name: "中国うさぎ",
      speaker_uuid: "uuid-usagi",
      styles: [
        { name: "ノーマル（低め）", id: 61 },
        { name: "おどろき", id: 62 },
        { name: "こわがり", id: 63 },
      ],
    },
    {
      name: "後鬼",
      speaker_uuid: "uuid-goki",
      styles: [
        { name: "人間ver.", id: 27 },
        { name: "ぬいぐるみver.", id: 28 },
        { name: "鬼ver.", id: 88 },
      ],
    },
    {
      name: "まお",
      speaker_uuid: "uuid-mao",
      styles: [
        { name: "おちつき", id: 501 },
        { name: "ふつー", id: 502 },
      ],
    },
    {
      name: "英語の話者",
      speaker_uuid: "uuid-en",
      styles: [
        { name: "Calm", id: 701 },
        { name: "NORMAL", id: 702 },
      ],
    },
  ]);

  test("再現：「喜び」を選んだ青山龍星の悲しみの台詞は「かなしみ」へ切り替わる", () => {
    expect(pickStyleForEmotion(speakers, 83, "悲しみ")).toEqual({ styleId: 85, styled: true });
  });

  test("ひらがな・言い換えの名前に当たる（怒り＝おこ・喜び＝わーい・恐れ＝びくびく・悲しみ＝びえーん・驚き＝おどろき・叫び＝熱血）", () => {
    expect(pickStyleForEmotion(speakers, 12, "怒り").styleId).toBe(34);
    expect(pickStyleForEmotion(speakers, 12, "喜び").styleId).toBe(32);
    expect(pickStyleForEmotion(speakers, 12, "恐れ").styleId).toBe(33);
    expect(pickStyleForEmotion(speakers, 12, "悲しみ").styleId).toBe(35);
    expect(pickStyleForEmotion(speakers, 61, "驚き").styleId).toBe(62);
    expect(pickStyleForEmotion(speakers, 61, "恐れ").styleId).toBe(63);
    expect(pickStyleForEmotion(speakers, 13, "叫び").styleId).toBe(81);
    expect(pickStyleForEmotion(speakers, 13, "怒り").styleId).toBe(82);
  });

  test("声の形の名前（人間ver. など）は、どの感情にも当てない（選んだスタイルのまま）", () => {
    for (const emotion of VOICE_EMOTIONS) {
      expect(pickStyleForEmotion(speakers, 27, emotion)).toEqual({ styleId: 27, styled: false });
    }
  });

  test("平静の声：同じ話者のノーマル・ふつう・ふつー（英語は大文字小文字を問わない）。無ければ選んだスタイルのまま", () => {
    expect(pickNormalStyle(speakers, 83)).toBe(13);
    expect(pickNormalStyle(speakers, 32)).toBe(12);
    expect(pickNormalStyle(speakers, 501)).toBe(502);
    expect(pickNormalStyle(speakers, 701)).toBe(702);
    expect(pickNormalStyle(speakers, 13)).toBe(13);
    // ノーマルを持たない話者・名前の一部だけ同じ（「ノーマル（低め）」）は選んだまま
    expect(pickNormalStyle(speakers, 28)).toBe(28);
    expect(pickNormalStyle(speakers, 62)).toBe(62);
    // 一覧に無い番号はそのまま
    expect(pickNormalStyle(speakers, 99999)).toBe(99999);
  });
});

/*
 * スタイルは感情に合わせて自動で選ぶ（作者の答え 2026-11-13「スタイルは自動で割り振ってください」）。
 * 名前から感情を推し量るのはコードだけ（AI は使わない）。当てられない名前は「声の形」として扱う。
 */
describe("スタイルの名前から感情を推し量る（作者の答え 2026-11-13）", () => {
  test("表の名前に当たる（今の pickStyleForEmotion と同じ当て方）", () => {
    expect(styleEmotionOf("上機嫌")).toBe("喜び");
    expect(styleEmotionOf("かなしみ")).toBe("悲しみ");
    expect(styleEmotionOf("怒り・悲しみ")).toBe("怒り");
    expect(styleEmotionOf("ささやき")).toBe("ささやき");
    expect(styleEmotionOf("Happy")).toBe("喜び");
  });

  test("表に無くても、感情を表す漢字1字で当てる", () => {
    expect(styleEmotionOf("涙声")).toBe("悲しみ");
    expect(styleEmotionOf("哀愁")).toBe("悲しみ");
    expect(styleEmotionOf("憤慨")).toBe("怒り");
    expect(styleEmotionOf("笑顔")).toBe("喜び");
    expect(styleEmotionOf("嬉々")).toBe("喜び");
    expect(styleEmotionOf("驚愕")).toBe("驚き");
    expect(styleEmotionOf("怖々")).toBe("恐れ");
    expect(styleEmotionOf("恥じらい")).toBe("照れ");
    expect(styleEmotionOf("囁")).toBe("ささやき");
    expect(styleEmotionOf("大叫")).toBe("叫び");
  });

  test("声の形・ふだんの声の名前は、どの感情にも当てない", () => {
    for (const name of ["人間ver.", "ぬいぐるみver.", "しっとり", "アナウンス", "読み聞かせ", "おちつき", "Calm", "ノーマル", "ふつう", "Normal"]) {
      expect(styleEmotionOf(name), name).toBeUndefined();
    }
  });

  test("作者の上書き（emotionStyles）に書いた名前は、その感情に結びつく", () => {
    expect(styleEmotionOf("しっとり", { 悲しみ: ["しっとり"] })).toBe("悲しみ");
  });

  test("ふだんの声の名前（全体で一致したものだけ。英語は大文字小文字を問わない）", () => {
    expect(isNormalStyleName("ノーマル")).toBe(true);
    expect(isNormalStyleName("ふつー")).toBe(true);
    expect(isNormalStyleName("NORMAL")).toBe(true);
    expect(isNormalStyleName(" ふつう ")).toBe(true);
    expect(isNormalStyleName("ノーマル（低め）")).toBe(false);
    expect(isNormalStyleName("しっとり")).toBe(false);
  });

  test("感情のスタイルを探すときも、表の名前の最後に漢字1字で当てる", () => {
    const list = parseSpeakers([
      {
        name: "漢字の話者",
        speaker_uuid: "uuid-kanji",
        styles: [
          { name: "ノーマル", id: 900 },
          { name: "涙声", id: 901 },
          { name: "憤慨", id: 902 },
        ],
      },
    ]);
    expect(pickStyleForEmotion(list, 900, "悲しみ")).toEqual({ styleId: 901, styled: true });
    expect(pickStyleForEmotion(list, 900, "怒り")).toEqual({ styleId: 902, styled: true });
    expect(pickStyleForEmotion(list, 900, "照れ")).toEqual({ styleId: 900, styled: false });
  });
});

describe("［声の割り当て］の声の行は「話者 × 声の形」だけ（作者の答え 2026-11-13）", () => {
  const list = parseSpeakers([
    {
      name: "青山龍星",
      speaker_uuid: "uuid-ryusei",
      styles: [
        { name: "喜び", id: 83 },
        { name: "ノーマル", id: 13 },
        { name: "しっとり", id: 84 },
        { name: "かなしみ", id: 85 },
      ],
    },
    {
      name: "後鬼",
      speaker_uuid: "uuid-goki",
      styles: [
        { name: "人間ver.", id: 27 },
        { name: "ぬいぐるみver.", id: 28 },
      ],
    },
    {
      name: "感情だけの話者",
      speaker_uuid: "uuid-emo",
      styles: [
        { name: "上機嫌", id: 41 },
        { name: "怒り", id: 42 },
      ],
    },
  ]);

  test("ノーマルは話者名だけ、声の形は話者名／スタイル名。感情のスタイルの行は出さない", () => {
    expect(voiceChoiceRows(list).map((row) => [row.label, row.style.id])).toEqual([
      ["青山龍星", 13],
      ["青山龍星／しっとり", 84],
      ["後鬼／人間ver.", 27],
      ["後鬼／ぬいぐるみver.", 28],
      ["感情だけの話者", 41],
    ]);
  });

  test("選んだ声の名前：感情のスタイル・ノーマルは話者名だけ、声の形は話者名／スタイル名（前の版の「喜び」も自動の表示）", () => {
    expect(voiceChoiceName("青山龍星", "喜び")).toBe("青山龍星");
    expect(voiceChoiceName("青山龍星", "ノーマル")).toBe("青山龍星");
    expect(voiceChoiceName("青山龍星", "しっとり")).toBe("青山龍星／しっとり");
    expect(voiceChoiceName("後鬼", "人間ver.")).toBe("後鬼／人間ver.");
  });
});

describe("人物ごとの声の調整（作者の頼み 2026-11-13）", () => {
  test("読む：幅の外・数でない値はその欄だけ捨てる。標準の値の欄は持たない。何も残らなければ無し", () => {
    expect(parseVoiceAdjust({ pitch: -0.06, speed: 0.85, intonation: 0.8 })).toEqual({ pitch: -0.06, speed: 0.85, intonation: 0.8 });
    expect(parseVoiceAdjust({ pitch: 0.5, speed: "1.1", intonation: Number.NaN })).toBeUndefined();
    expect(parseVoiceAdjust({ pitch: 0.5, speed: 1.1 })).toEqual({ speed: 1.1 });
    expect(parseVoiceAdjust({ pitch: 0, speed: 1, intonation: 1 })).toBeUndefined();
    expect(parseVoiceAdjust("老けた声")).toBeUndefined();
    expect(parseVoiceAdjust(undefined)).toBeUndefined();
    expect(parseVoiceAdjust([0.1])).toBeUndefined();
  });

  test("段の値はどれも読める（幅の端を含む）", () => {
    for (const field of ["pitch", "speed", "intonation"] as const) {
      for (const value of VOICE_ADJUST_STEPS[field]) {
        const parsed = parseVoiceAdjust({ [field]: value });
        if (value === (field === "pitch" ? 0 : 1)) expect(parsed).toBeUndefined();
        else expect(parsed).toEqual({ [field]: value });
      }
    }
  });

  test("幅は 高さ ±0.12・速さ 0.8〜1.2・抑揚 0.7〜1.3（作者の決定 2026-11-13 夕）。端は読め、外は捨てる", () => {
    for (const value of [-0.12, 0.12]) expect(parseVoiceAdjust({ pitch: value })).toEqual({ pitch: value });
    for (const value of [0.8, 1.2]) expect(parseVoiceAdjust({ speed: value })).toEqual({ speed: value });
    for (const value of [0.7, 1.3]) expect(parseVoiceAdjust({ intonation: value })).toEqual({ intonation: value });
    for (const value of [-0.13, 0.13]) expect(parseVoiceAdjust({ pitch: value })).toBeUndefined();
    for (const value of [0.75, 1.25]) expect(parseVoiceAdjust({ speed: value })).toBeUndefined();
    for (const value of [0.65, 1.35]) expect(parseVoiceAdjust({ intonation: value })).toBeUndefined();
    // 前の版の見本の値（幅の中）はそのまま読める
    expect(parseVoiceAdjust({ pitch: -0.06, speed: 0.85, intonation: 0.8 })).toEqual({ pitch: -0.06, speed: 0.85, intonation: 0.8 });
  });

  test("段の並び：高さ −0.12〜+0.12 を0.03刻み、速さ 0.8〜1.2 を0.05刻み、抑揚 0.7〜1.3 を0.1刻み", () => {
    expect(VOICE_ADJUST_STEPS.pitch).toEqual([-0.12, -0.09, -0.06, -0.03, 0, 0.03, 0.06, 0.09, 0.12]);
    expect(VOICE_ADJUST_STEPS.speed).toEqual([0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2]);
    expect(VOICE_ADJUST_STEPS.intonation).toEqual([0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3]);
  });

  test("見本「老けた声」は 高さ −0.12・速さ 0.8・抑揚 0.7（作者の決定 2026-11-13 夕。VOICEVOX の四国めたんで老人に聞こえた値）", () => {
    const aged = VOICE_ADJUST_PRESETS.find((preset) => preset.name === "老けた声");
    expect(aged?.adjust).toEqual({ pitch: -0.12, speed: 0.8, intonation: 0.7 });
    expect(describeVoiceAdjust(aged?.adjust)).toBe("高さ −0.12・速さ 0.8・抑揚 0.7");
    // 見本は VOICEVOX の声にだけ出す。AivisSpeech は年配の声のモデルを選ぶほうが近い
    expect(presetsForEngine("voicevox").map((preset) => preset.name)).toEqual(["老けた声"]);
    expect(presetsForEngine("aivisspeech")).toEqual([]);
    expect(describeVoiceAdjust(undefined)).toBe("");
    expect(describeVoiceAdjust({ pitch: 0.03 })).toBe("高さ +0.03");
  });

  test("足し方：高さは足し、速さと抑揚は掛ける。感情の寄せと列の速さと合わせる", () => {
    const plain = voiceParamsFor("平静", "中", false, 1);
    const aged = voiceParamsFor("平静", "中", false, 1, { pitch: -0.06, speed: 0.85, intonation: 0.8 });
    expect(aged).toMatchObject({ speedScale: 0.85, pitchScale: -0.06, intonationScale: 0.8, volumeScale: plain.volumeScale });
    // 喜び（中）の寄せ：速さ 1.04・高さ +0.03・抑揚 1.15 に、列の速さ 1.2 と調整を合わせる
    const joy = voiceParamsFor("喜び", "中", false, 1.2, { pitch: -0.06, speed: 0.85, intonation: 0.8 });
    expect(joy.speedScale).toBeCloseTo(1.04 * 1.2 * 0.85, 3);
    expect(joy.pitchScale).toBeCloseTo(0.03 - 0.06, 3);
    expect(joy.intonationScale).toBeCloseTo(1.15 * 0.8, 3);
  });

  test("合わせたあとも幅（speed 0.5〜2・pitch ±0.15・intonation 0〜2）に収める", () => {
    const loud = voiceParamsFor("叫び", "強", false, 2, { pitch: 0.12, speed: 1.2, intonation: 1.3 });
    expect(loud.speedScale).toBeLessThanOrEqual(2);
    expect(loud.pitchScale).toBeLessThanOrEqual(0.15);
    expect(loud.intonationScale).toBeLessThanOrEqual(2);
    const low = voiceParamsFor("悲しみ", "強", false, 0.5, { pitch: -0.12, speed: 0.8, intonation: 0.7 });
    expect(low.speedScale).toBeGreaterThanOrEqual(0.5);
    expect(low.pitchScale).toBeGreaterThanOrEqual(-0.15);
    // 驚き（強）の高さ +0.09 に +0.06 を足すと 0.15 で止まる
    expect(voiceParamsFor("驚き", "強", false, 1, { pitch: 0.06 }).pitchScale).toBe(0.15);
    // 壊れた調整は標準として扱う
    expect(voiceParamsFor("平静", "中", false, 1, { pitch: 9 } as never)).toEqual(voiceParamsFor("平静", "中", false, 1));
  });

  test("合成の控えの鍵：調整が違えば別の音", () => {
    const plain = voiceParamsFor("平静", "中", false, 1);
    const aged = voiceParamsFor("平静", "中", false, 1, { pitch: -0.06 });
    const slow = voiceParamsFor("平静", "中", false, 1, { speed: 0.85 });
    const keys = [plain, aged, slow].map((params) => synthesisKey("http://a", 1, "文", params));
    expect(new Set(keys).size).toBe(3);
  });
});

/*
  専用のスタイルが無い感情（作者の決定 2026-11-13、案C）。AivisSpeech は intonationScale をノーマルのスタイルで
  無視するので、速さと緩急（tempoDynamicsScale）で寄せる。声を選んだときに、無い感情を知らせる
*/
describe("専用のスタイルが無い感情の寄せ方と知らせ（作者の決定 2026-11-13）", () => {
  const speakers = parseSpeakers(FAKE_SPEAKERS);

  test("AivisSpeech・スタイル無し・怒り：緩急は1より大きく、速さは今の寄せより大きい", () => {
    const before = voiceParamsFor("怒り", "中", false, 1);
    const aivis = voiceParamsFor("怒り", "中", false, 1, undefined, "aivisspeech");
    expect(aivis.tempoDynamicsScale).toBeGreaterThan(1);
    expect(aivis.speedScale).toBeGreaterThan(before.speedScale);
    // 高さ・抑揚・音量・後ろの無音は今のまま（AivisSpeech の pitch は別に訊く）
    expect(aivis.pitchScale).toBe(before.pitchScale);
    expect(aivis.intonationScale).toBe(before.intonationScale);
    expect(aivis.volumeScale).toBe(before.volumeScale);
    expect(aivis.postPhonemeLength).toBe(before.postPhonemeLength);
  });

  test("強さは今の係数（弱0.5・中1・強1.5）で、緩急は 1＋(値−1)×係数。列の速さと人物の調整も今までどおり掛ける", () => {
    expect(voiceParamsFor("叫び", "中", false, 1, undefined, "aivisspeech").tempoDynamicsScale).toBeCloseTo(1.45, 3);
    expect(voiceParamsFor("叫び", "強", false, 1, undefined, "aivisspeech").tempoDynamicsScale).toBeCloseTo(1.675, 3);
    expect(voiceParamsFor("悲しみ", "弱", false, 1, undefined, "aivisspeech").tempoDynamicsScale).toBeCloseTo(0.85, 3);
    expect(voiceParamsFor("怒り", "中", false, 1, undefined, "aivisspeech").speedScale).toBeCloseTo(1.12, 3);
    expect(voiceParamsFor("悲しみ", "中", false, 1, undefined, "aivisspeech").speedScale).toBeCloseTo(0.88, 3);
    expect(voiceParamsFor("怒り", "中", false, 1.5, { speed: 0.9 }, "aivisspeech").speedScale).toBeCloseTo(1.12 * 1.5 * 0.9, 3);
    // 幅（speed 0.5〜2・緩急 0〜2）に収める
    expect(voiceParamsFor("叫び", "強", false, 2, { speed: 1.15 }, "aivisspeech").speedScale).toBe(2);
  });

  test("VOICEVOX・スタイルが見つかったとき・エンジンを渡さないときは緩急の欄を持たず、値も今のまま", () => {
    const voicevox = voiceParamsFor("怒り", "強", false, 1, undefined, "voicevox");
    expect(voicevox).not.toHaveProperty("tempoDynamicsScale");
    expect(voicevox).toEqual(voiceParamsFor("怒り", "強", false, 1));
    const styled = voiceParamsFor("怒り", "強", true, 1, undefined, "aivisspeech");
    expect(styled).not.toHaveProperty("tempoDynamicsScale");
    expect(styled).toEqual(voiceParamsFor("怒り", "強", true, 1));
    // 欄が無ければ audio_query の答えの既定値を消さない
    expect(applyVoiceParams({ tempoDynamicsScale: 1 }, styled).tempoDynamicsScale).toBe(1);
  });

  test("平静は AivisSpeech でも変わらない", () => {
    const calm = voiceParamsFor("平静", "中", false, 1, undefined, "aivisspeech");
    expect(calm).not.toHaveProperty("tempoDynamicsScale");
    expect(calm).toEqual(voiceParamsFor("平静", "中", false, 1));
  });

  test("緩急は audio_query へ送られ、合成の控えの鍵も緩急で変わる", () => {
    const aivis = voiceParamsFor("怒り", "中", false, 1, undefined, "aivisspeech");
    expect(applyVoiceParams({ tempoDynamicsScale: 1 }, aivis).tempoDynamicsScale).toBe(aivis.tempoDynamicsScale);
    const base = voiceParamsFor("平静", "中", false, 1);
    const keys = [base, { ...base, tempoDynamicsScale: 1.3 }, { ...base, tempoDynamicsScale: 1.2 }].map((params) =>
      synthesisKey("http://a", 1, "文", params)
    );
    expect(new Set(keys).size).toBe(3);
  });

  test("無い感情の一覧は pickStyleForEmotion と同じ判定（平静は数えない・作者の上書きも見る）", () => {
    // まい：上機嫌（喜び）・怒り・悲しみ（怒り・悲しみ・叫び）
    expect(missingEmotionStyles(speakers, 888753760)).toEqual(["驚き", "恐れ", "照れ", "ささやき"]);
    expect(missingEmotionStyles(speakers, 888753760, { 驚き: ["上機嫌"] })).toEqual(["恐れ", "照れ", "ささやき"]);
    const kanon = missingEmotionStyles(speakers, 1325133120);
    expect(kanon).not.toContain("平静");
    expect(kanon).not.toContain("ささやき");
    for (const emotion of kanon) {
      expect(pickStyleForEmotion(speakers, 1325133120, emotion).styled).toBe(false);
    }
  });

  test("知らせの文：無い感情の名前を並べ、全部あれば出さない", () => {
    expect(missingEmotionStyleNotice("まい", ["怒り", "叫び"])).toBe(
      "この声（まい）には怒り・叫びの声（スタイル）がありません。その感情は平静に近く聞こえます。"
    );
    expect(missingEmotionStyleNotice("まい", ["怒り"], "aivisspeech")).toBe(
      "この声（まい）には怒りの声（スタイル）がありません。その感情は声を替えず、速さと緩急だけで寄せるので、平静に近く聞こえることがあります。"
    );
    expect(missingEmotionStyleNotice("まい", [])).toBeUndefined();
    const full = [
      {
        name: "全部",
        uuid: "uuid-full",
        styles: [
          { name: "ノーマル", id: 1 },
          ...VOICE_EMOTIONS.filter((emotion) => emotion !== "平静").map((emotion, index) => ({ name: emotion, id: 10 + index })),
        ],
      },
    ];
    expect(missingEmotionStyles(full, 1)).toEqual([]);
  });
});
