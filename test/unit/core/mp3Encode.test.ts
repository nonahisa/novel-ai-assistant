import { describe, expect, test } from "vitest";
import { Mp3Encoder } from "@breezystack/lamejs";
import { encodeMp3, type Mp3EncoderFactory } from "../../../src/core/mp3Encode";
import { joinClips, parseWav } from "../../../src/core/wavPcm";
import { VoiceEngineError } from "../../../src/core/voiceEngine";
import { pcmWav } from "../support/fakeVoiceEngine";

/**
 * つないだ音を MP3 にする（設計書6.42.4）。変換は LAME の JavaScript 版
 * （`@breezystack/lamejs`。製品では `dist/lame.js` を別のファイルとして読む）。
 *
 * 動いたと言える条件：
 * 1. 出てきたものが MP3 のフレームで始まる（同期の 11ビットが立つ）
 * 2. 無音を長くすると、MP3 も長くなる（つないだ音を全部渡している）
 * 3. 中止できる（長い話の変換は数秒かかる）
 */
const lame: Mp3EncoderFactory = (channels, sampleRate, kbps) =>
  new Mp3Encoder(channels, sampleRate, kbps);

function isMp3Frame(bytes: Uint8Array): boolean {
  // フレームの頭は 0xFF と、次の上位3ビットが 1
  return bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

describe("MP3 にする", () => {
  test("MP3 のフレームで始まる", async () => {
    const clip = parseWav(pcmWav({ sampleRate: 24000, ms: 300 }));
    const mp3 = await encodeMp3(clip, lame);
    expect(isMp3Frame(mp3)).toBe(true);
  });

  test("無音を長くすると MP3 も長くなる", async () => {
    const clip = parseWav(pcmWav({ sampleRate: 24000, ms: 200 }));
    const short = await encodeMp3(joinClips([{ clip, gapMs: 0 }, { clip, gapMs: 30 }]), lame);
    const long = await encodeMp3(joinClips([{ clip, gapMs: 0 }, { clip, gapMs: 3000 }]), lame);
    expect(long.length).toBeGreaterThan(short.length * 2);
  });

  test("ステレオの WAV も変換できる", async () => {
    const clip = parseWav(pcmWav({ sampleRate: 44100, channels: 2, ms: 200 }));
    const mp3 = await encodeMp3(clip, lame);
    expect(isMp3Frame(mp3)).toBe(true);
  });

  test("中止したら途中で止めて、中止として投げる", async () => {
    const clip = parseWav(pcmWav({ sampleRate: 24000, ms: 2000 }));
    const controller = new AbortController();
    controller.abort();
    await expect(encodeMp3(clip, lame, { signal: controller.signal })).rejects.toBeInstanceOf(
      VoiceEngineError
    );
  });

  test("進み具合を知らせる（最後は全部）", async () => {
    const clip = parseWav(pcmWav({ sampleRate: 24000, ms: 3000 }));
    const seen: number[] = [];
    await encodeMp3(clip, lame, { onProgress: (done) => seen.push(done) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
  });
});
