import { describe, expect, test } from "vitest";
import {
  PACE_SLOW_STREAK,
  PACE_WARMUP_SENTENCES,
  expectedWorkSeconds,
  PACE_MEMORY_MIN,
  PACE_MEMORY_WINDOW,
  PACE_STORED_MAX_AGE_DAYS,
  PaceMemory,
  slowPaceNotice,
  SynthesisPaceWatch,
  wavSeconds,
} from "../../../src/core/voicePace";
import { pcmWav } from "../support/fakeVoiceEngine";

/**
 * 声づくりが読む速さに追いついているかの見張り（0.146.0。設計書6.42.3）。
 * ノートPCの実機確認：約8.5秒の音に 13.6〜23.3秒かかり、文の間があいた。
 */

describe("音の長さを WAV の頭から読む", () => {
  test("標本の数と標本の速さから秒にする", () => {
    expect(wavSeconds(new Uint8Array(pcmWav({ ms: 1500 })))).toBeCloseTo(1.5, 3);
    expect(wavSeconds(new Uint8Array(pcmWav({ ms: 800, sampleRate: 44100, channels: 2 })))).toBeCloseTo(0.8, 3);
  });

  test("読めない形なら測らない（読み上げは止めない）", () => {
    expect(wavSeconds(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeUndefined();
    expect(wavSeconds(new Uint8Array())).toBeUndefined();
  });
});

describe("知らせる条件", () => {
  test("はじめの数文を除いて、続けて遅い文が3つ並んだら、その平均の値で一度だけ知らせる", () => {
    expect(PACE_WARMUP_SENTENCES).toBe(2);
    expect(PACE_SLOW_STREAK).toBe(3);
    const watch = new SynthesisPaceWatch();
    // はじめの2文は遅くても数えない
    expect(watch.record(30, 8)).toBeUndefined();
    expect(watch.record(30, 8)).toBeUndefined();
    expect(watch.record(14, 8)).toBeUndefined();
    expect(watch.record(17, 8.5)).toBeUndefined();
    const slow = watch.record(20, 9);
    expect(slow?.audioSeconds).toBeCloseTo(8.5, 5);
    expect(slow?.elapsedSeconds).toBeCloseTo(17, 5);
    // 出すのは1回だけ
    expect(watch.record(20, 9)).toBeUndefined();
    expect(watch.record(20, 9)).toBeUndefined();
    expect(watch.record(20, 9)).toBeUndefined();
  });

  test("途中に追いついた文があれば数え直す（1文だけ遅いのは知らせない）", () => {
    const watch = new SynthesisPaceWatch();
    watch.record(1, 2);
    watch.record(1, 2);
    expect(watch.record(3, 2)).toBeUndefined();
    expect(watch.record(3, 2)).toBeUndefined();
    expect(watch.record(1, 2)).toBeUndefined(); // 追いついた
    expect(watch.record(3, 2)).toBeUndefined();
    expect(watch.record(3, 2)).toBeUndefined();
    expect(watch.record(3, 2)).toBeDefined();
  });

  test("ちょうど読む速さ（1倍）は遅いと数えない。長さの分からない文は数えない", () => {
    const watch = new SynthesisPaceWatch(0, 1);
    expect(watch.record(2, 2)).toBeUndefined();
    expect(watch.record(5, undefined)).toBeUndefined();
    expect(watch.record(2.1, 2)).toBeDefined();
  });

  test("始め直すと、また1回出せる（覚えずに、読み上げのたびに見る）", () => {
    const watch = new SynthesisPaceWatch(0, 1);
    expect(watch.record(3, 1)).toBeDefined();
    expect(watch.record(3, 1)).toBeUndefined();
    watch.reset();
    expect(watch.record(3, 1)).toBeDefined();
  });
});

describe("知らせの文", () => {
  test("測った値と、選んでいるエンジンの名前で出す。もう片方のエンジンは勧めない", () => {
    const text = slowPaceNotice("AivisSpeech", { audioSeconds: 8.46, elapsedSeconds: 17.2 });
    expect(text).toBe(
      "この PC では、AivisSpeech の声づくりが読む速さに追いついていません（8.5秒の音に約17秒）。" +
        "［音声に書き出す］で先に作っておくと、間をあけずに聞けます。"
    );
    expect(slowPaceNotice("VOICEVOX", { audioSeconds: 3, elapsedSeconds: 4 })).toContain("VOICEVOX の声づくり");
    expect(text).not.toContain("VOICEVOX");
  });
});

describe("測った速さの比を覚える（書き出しの見込み。2026-11-14）", () => {
  test("測っていなければ比を返さない（推測の数字を出さない）", () => {
    const memory = new PaceMemory<string>();
    expect(memory.ratio("aivisspeech")).toBeUndefined();
    // はじめの数文と、数が足りないうちは返さない
    for (let i = 0; i < 4; i++) memory.record("aivisspeech", 30, 8);
    expect(PACE_MEMORY_MIN).toBe(3);
    expect(memory.ratio("aivisspeech")).toBeUndefined();
  });

  test("はじめの数文を除いて、かかった秒の合計÷音の秒の合計を返す", () => {
    const memory = new PaceMemory<string>();
    memory.record("aivisspeech", 100, 1); // はじめの2文は数えない
    memory.record("aivisspeech", 100, 1);
    for (let i = 0; i < 3; i++) memory.record("aivisspeech", 37, 10);
    expect(memory.ratio("aivisspeech")).toBeCloseTo(3.7, 5);
  });

  test("エンジンごとに別の比を覚える", () => {
    const memory = new PaceMemory<string>(0);
    for (let i = 0; i < 3; i++) memory.record("aivisspeech", 37, 10);
    for (let i = 0; i < 3; i++) memory.record("voicevox", 5, 10);
    expect(memory.ratio("aivisspeech")).toBeCloseTo(3.7, 5);
    expect(memory.ratio("voicevox")).toBeCloseTo(0.5, 5);
  });

  test("測れない文（音の長さ不明・0秒・非有限）は数えない。古い文は捨てて直近で出す", () => {
    const memory = new PaceMemory<string>(0);
    memory.record("a", 10, undefined);
    memory.record("a", 10, 0);
    memory.record("a", Number.NaN, 5);
    expect(memory.ratio("a")).toBeUndefined();
    for (let i = 0; i < PACE_MEMORY_WINDOW; i++) memory.record("a", 100, 1);
    for (let i = 0; i < PACE_MEMORY_WINDOW; i++) memory.record("a", 2, 1);
    expect(memory.ratio("a")).toBeCloseTo(2, 5);
  });

  test("保存して読み戻すと同じ比になる（再起動のあとの最初の書き出しでも使える）", () => {
    const day = 24 * 3600 * 1000;
    let now = Date.parse("2026-11-14T00:00:00Z");
    const first = new PaceMemory<string>(0, () => now);
    for (let i = 0; i < 5; i++) first.record("aivisspeech", 37, 10);
    const saved = JSON.parse(JSON.stringify(first.snapshot()));
    expect(saved.aivisspeech).toEqual({ ratio: expect.closeTo(3.7, 5), count: 5, at: "2026-11-14T00:00:00.000Z" });
    // 再起動：新しい覚えは空。読み戻すと同じ比（要約だけ。本文や文は入っていない）
    now += 3 * day;
    const second = new PaceMemory<string>(0, () => now);
    expect(second.ratio("aivisspeech")).toBeUndefined();
    expect(second.restore(saved)).toBe(true);
    expect(second.ratio("aivisspeech")).toBeCloseTo(3.7, 5);
    // 読み戻した比も、次の保存にそのまま残る（まだ測り直していないエンジンの比を消さない）
    expect(second.snapshot().aivisspeech?.ratio).toBeCloseTo(3.7, 5);
    // 今回の起動で十分に測れたら、そちらを使う
    for (let i = 0; i < 3; i++) second.record("aivisspeech", 10, 10);
    expect(second.ratio("aivisspeech")).toBeCloseTo(1, 5);
  });

  test("壊れた値（形が違う・数でない・0以下・日時が読めない）は使わず捨てる。壊れていたかを返す", () => {
    const memory = new PaceMemory<string>(0, () => Date.parse("2026-11-14T00:00:00Z"));
    const at = "2026-11-13T00:00:00.000Z";
    expect(memory.restore("壊れた")).toBe(false);
    expect(memory.restore(null)).toBe(true);
    expect(memory.restore(undefined)).toBe(true);
    expect(
      memory.restore({
        aivisspeech: { ratio: "3.7", count: 5, at },
        voicevox: { ratio: 0, count: 5, at },
        other: { ratio: 2, count: 5, at: "いつか" },
        broken: 7,
      })
    ).toBe(false);
    for (const key of ["aivisspeech", "voicevox", "other", "broken"]) expect(memory.ratio(key)).toBeUndefined();
    // 壊れていないものだけは使う
    expect(memory.restore({ ok: { ratio: 2, count: 5, at }, bad: { ratio: Number.NaN, count: 5, at } })).toBe(false);
    expect(memory.ratio("ok")).toBe(2);
    expect(memory.ratio("bad")).toBeUndefined();
  });

  test("古い比（90日より前）は使わない。数えた文が少なすぎるものも使わない", () => {
    expect(PACE_STORED_MAX_AGE_DAYS).toBe(90);
    const now = Date.parse("2026-11-14T00:00:00Z");
    const memory = new PaceMemory<string>(0, () => now);
    memory.restore({
      fresh: { ratio: 3, count: 10, at: "2026-08-17T00:00:00.000Z" }, // ちょうど89日前
      old: { ratio: 3, count: 10, at: "2026-08-10T00:00:00.000Z" }, // 96日前
      few: { ratio: 3, count: 1, at: "2026-11-13T00:00:00.000Z" },
      future: { ratio: 3, count: 10, at: "2026-12-14T00:00:00.000Z" },
    });
    expect(memory.ratio("fresh")).toBe(3);
    expect(memory.ratio("old")).toBeUndefined();
    expect(memory.ratio("few")).toBeUndefined();
    expect(memory.ratio("future")).toBeUndefined();
  });

  test("書き出しの見込み：音の長さ×比。1つでも比が無ければ出さない", () => {
    expect(expectedWorkSeconds([{ audioSeconds: 500, ratio: 3.7 }])).toBeCloseTo(1850, 5);
    expect(
      expectedWorkSeconds([
        { audioSeconds: 400, ratio: 3 },
        { audioSeconds: 100, ratio: 0.5 },
      ])
    ).toBeCloseTo(1250, 5);
    expect(
      expectedWorkSeconds([
        { audioSeconds: 400, ratio: 3 },
        { audioSeconds: 100, ratio: undefined },
      ])
    ).toBeUndefined();
    expect(expectedWorkSeconds([])).toBeUndefined();
  });
});
