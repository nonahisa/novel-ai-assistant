import { describe, expect, test } from "vitest";
import { joinClips, parseWav } from "../../../src/core/wavPcm";
import { fakeWav, pcmWav } from "../support/fakeVoiceEngine";

/**
 * 文ごとの WAV を1話の音へつなぐ（設計書6.42.4）。
 *
 * 動いたと言える条件：
 * 1. 塊（`fmt `・`LIST`・`data`）を歩いて読む（44バイト固定と決めつけない）
 * 2. 文の間（gapMs）の無音が、標本の数どおりに入る
 * 3. 形（標本化の速さ・声の数・ビット数）が揃わない WAV はつながずに止める
 */
describe("WAV を読む", () => {
  test("LIST の塊が data の前にあっても読める", () => {
    const clip = parseWav(pcmWav({ sampleRate: 24000, ms: 100 }));
    expect(clip.format).toEqual({ sampleRate: 24000, channels: 1 });
    expect(clip.samples.length).toBe(2400);
    // 正弦波の頭は 0、少し先は 0 ではない（data の中身を読めている）
    expect(clip.samples[0]).toBe(0);
    expect(clip.samples.some((v) => v !== 0)).toBe(true);
  });

  test("RIFF でないもの・data の無いものは止める", () => {
    expect(() => parseWav(new Uint8Array([1, 2, 3]))).toThrow(/WAV/);
    expect(() => parseWav(fakeWav("x"))).toThrow(/WAV/);
  });

  test("16bit PCM 以外は止める", () => {
    const wav = pcmWav();
    // fmt の「ビット数」（RIFF 12 + 塊の頭 8 + 14）を 8 にする
    wav.writeUInt16LE(8, 12 + 8 + 14);
    expect(() => parseWav(wav)).toThrow(/16bit/);
  });
});

describe("文をつなぐ", () => {
  test("文の間の無音を標本の数どおりに入れる", () => {
    const a = parseWav(pcmWav({ sampleRate: 24000, ms: 100 }));
    const b = parseWav(pcmWav({ sampleRate: 24000, ms: 50 }));
    const joined = joinClips([
      { clip: a, gapMs: 0 },
      { clip: b, gapMs: 280 },
    ]);
    // 2400 + 280ms ぶんの 6720 + 1200
    expect(joined.samples.length).toBe(2400 + 6720 + 1200);
    expect([...joined.samples.subarray(2400, 2400 + 6720)].every((v) => v === 0)).toBe(true);
    expect(joined.format).toEqual({ sampleRate: 24000, channels: 1 });
  });

  test("最初の文の前には間を入れない", () => {
    const a = parseWav(pcmWav({ ms: 100 }));
    expect(joinClips([{ clip: a, gapMs: 500 }]).samples.length).toBe(2400);
  });

  test("標本化の速さが違う WAV はつながない", () => {
    const a = parseWav(pcmWav({ sampleRate: 24000 }));
    const b = parseWav(pcmWav({ sampleRate: 44100 }));
    expect(() =>
      joinClips([
        { clip: a, gapMs: 0 },
        { clip: b, gapMs: 90 },
      ])
    ).toThrow(/揃いません/);
  });

  test("声が2つ（ステレオ）なら、無音も2つぶん入れる", () => {
    const a = parseWav(pcmWav({ channels: 2, ms: 10 }));
    const joined = joinClips([
      { clip: a, gapMs: 0 },
      { clip: a, gapMs: 10 },
    ]);
    expect(joined.samples.length).toBe(240 * 2 * 3);
  });
});
