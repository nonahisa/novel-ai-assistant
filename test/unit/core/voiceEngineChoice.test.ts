import { describe, expect, test } from "vitest";
import {
  legacyEngineOf,
  legacyVoiceEngine,
  resolveEngineUrl,
  VoiceEngineError,
  voiceEngineDownPrompt,
  voiceEngineNextStep,
} from "../../../src/core/voiceEngine";

/**
 * 音声合成のエンジンを選ぶ（AivisSpeech・VOICEVOX。0.146.0。設計書6.42.3）。
 * 作者の決定（2026-11-08）：［声］で選べるようにし、接続先の設定をエンジンごとに分ける。
 */

describe("エンジンごとの接続先", () => {
  test("何も書いていなければ、それぞれの既定", () => {
    expect(resolveEngineUrl("aivisspeech", {})).toEqual({ url: "http://127.0.0.1:10101", fromLegacy: false });
    expect(resolveEngineUrl("voicevox", {})).toEqual({ url: "http://127.0.0.1:50021", fromLegacy: false });
  });

  test("新しい設定を書けばそれが先に立つ（古い設定より強い）。読めない形は undefined", () => {
    const settings = { voicevoxUrl: "http://192.168.3.15:50021/", legacyUrl: "http://127.0.0.1:50021" };
    expect(resolveEngineUrl("voicevox", settings)).toEqual({ url: "http://192.168.3.15:50021", fromLegacy: false });
    expect(resolveEngineUrl("aivisspeech", { aivisSpeechUrl: "file:///x" }).url).toBeUndefined();
  });

  test("古い設定を書き換えていたら、指している側の接続先として読む（50021 なら VOICEVOX、ほかは AivisSpeech）", () => {
    const remote = { legacyUrl: "http://192.168.3.15:10101" };
    expect(resolveEngineUrl("aivisspeech", remote)).toEqual({ url: "http://192.168.3.15:10101", fromLegacy: true });
    // 指していない側は既定のまま
    expect(resolveEngineUrl("voicevox", remote)).toEqual({ url: "http://127.0.0.1:50021", fromLegacy: false });

    const voicevox = { legacyUrl: "http://studio-pc:50021" };
    expect(resolveEngineUrl("voicevox", voicevox)).toEqual({ url: "http://studio-pc:50021", fromLegacy: true });
    expect(resolveEngineUrl("aivisspeech", voicevox).url).toBe("http://127.0.0.1:10101");
  });

  test("古い設定が既定のままなら使わない（書いた値でも既定と同じなら同じ）", () => {
    expect(resolveEngineUrl("aivisspeech", { legacyUrl: "http://127.0.0.1:10101/" }).fromLegacy).toBe(false);
  });

  test("前の版で「人物の声」を選んでいた人は、古い設定が指している側で読む", () => {
    expect(legacyVoiceEngine({})).toBe("aivisspeech");
    expect(legacyVoiceEngine({ legacyUrl: "http://127.0.0.1:10101" })).toBe("aivisspeech");
    expect(legacyVoiceEngine({ legacyUrl: "http://127.0.0.1:50021" })).toBe("voicevox");
    expect(legacyVoiceEngine({ legacyUrl: "http://192.168.3.15:10101" })).toBe("aivisspeech");
    expect(legacyEngineOf("読めない")).toBe("aivisspeech");
  });
});

describe("届かなかったときの文にエンジンの名前を入れる", () => {
  test("見出しと詳しい文に、選んだエンジンの名前", () => {
    const prompt = voiceEngineDownPrompt("read", "voicevox");
    expect(prompt.message).toBe("音声合成のエンジン（VOICEVOX）に繋がりませんでした。");
    expect(prompt.detail).toContain("VOICEVOX を起動してから、もう一度［▶ 読む］");
    expect(prompt.useOtherEngine).toBeUndefined();
    expect(voiceEngineDownPrompt("assign", "aivisspeech").detail).toContain("AivisSpeech を起動してから");
    expect(voiceEngineDownPrompt("export", "voicevox").message).toContain("（VOICEVOX）");
  });

  test("次の操作の1文にも、失敗の印のエンジンを入れる", () => {
    const error = new VoiceEngineError("unreachable", "応答がありません", undefined, "voicevox");
    expect(voiceEngineNextStep(error)).toContain("音声合成のエンジン（VOICEVOX）に繋がりませんでした。VOICEVOX を起動してから");
  });

  test("もう片方が動いていれば、宛先を書き、［〇〇で読む］を足す（［OSの声で読む］は残す）", () => {
    const prompt = voiceEngineDownPrompt("read", "voicevox", { engine: "aivisspeech", host: "127.0.0.1:10101" });
    expect(prompt.message).toBe("音声合成のエンジン（VOICEVOX）に繋がりませんでした。");
    expect(prompt.detail).toContain("AivisSpeech（127.0.0.1:10101）が動いています。こちらで読みますか。");
    expect(prompt.useOtherEngine).toBe("AivisSpeech で読む");
    expect(prompt.useOsVoice).toBe("OSの声で読む");
  });
});
