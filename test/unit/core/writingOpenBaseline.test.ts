import { describe, expect, test } from "vitest";
import type { WritingMeasurement } from "../../../src/models/writingStats";
import {
  emptyDeviceStats,
  placeOpenBaseline,
  rebaseline,
  recordMeasurement,
  sumRange,
} from "../../../src/core/writingStats";
import { OpenDayGate } from "../../../src/core/writingOpenGate";

/**
 * 話を開いたときの字数を、その日の数え始めに置く（作者の答え、2026-11-12）。
 * Ctrl+S が本体の保存と［保存］の両方を走らせる順番で、今日の字数が1字ずれた不具合の再現を含む。
 */

const A = "本文/001.txt";
const B = "本文/002.txt";

/** 2話の作品の測り。a・b はそれぞれの純文字数 */
function measure(a: number, b = 7): WritingMeasurement {
  return {
    net: a + b,
    gross: a + b,
    fileCount: 2,
    conflictedCount: 0,
    files: { [A]: { net: a, gross: a }, [B]: { net: b, gross: b } },
  };
}

const NOON = new Date("2026-11-12T12:00:00+09:00");
const todayNet = (stats: ReturnType<typeof emptyDeviceStats>): number =>
  sumRange(stats.days, "2026-11-12", "2026-11-12").net;

describe("開いたときの字数を起点に置く", () => {
  test("起点がまだ無ければ、作品全体の起点を置き、記録（days）は増やさない", () => {
    const next = placeOpenBaseline(emptyDeviceStats("d"), measure(13), A, NOON);
    expect(next.baseline?.net).toBe(20);
    expect(next.baseline?.files?.[A]).toEqual({ net: 13, gross: 13 });
    expect(next.days).toEqual([]);
  });

  test("起点があれば、開いた話の分だけ置き直し、ほかの話の保存前の差には触らない", () => {
    let stats = placeOpenBaseline(emptyDeviceStats("d"), measure(13, 7), A, NOON);
    // 別の道（外のエディター）で A が 13→20、B が 7→9 に変わった状態で A を開く
    stats = placeOpenBaseline(stats, measure(20, 9), A, NOON);
    expect(stats.baseline?.files?.[A]).toEqual({ net: 20, gross: 20 });
    // B は基準のまま（次に保存したとき +2 として数えられる）
    expect(stats.baseline?.files?.[B]).toEqual({ net: 7, gross: 7 });
    expect(stats.baseline?.net).toBe(27);
    const saved = recordMeasurement(stats, measure(20, 9), { at: NOON });
    expect(saved.delta).toBe(2);
  });

  test("ファイル数が変わっていたら、作品全体を置き直す（取り込みは書いた量にしない）", () => {
    let stats = placeOpenBaseline(emptyDeviceStats("d"), measure(13), A, NOON);
    const three: WritingMeasurement = {
      ...measure(13),
      net: 400,
      gross: 400,
      fileCount: 3,
    };
    stats = placeOpenBaseline(stats, three, A, NOON);
    expect(stats.baseline?.net).toBe(400);
    expect(stats.days).toEqual([]);
  });

  test("起点に話が無い（名前の変更など）ときは何も変えない", () => {
    const stats = placeOpenBaseline(emptyDeviceStats("d"), measure(13), A, NOON);
    const same = placeOpenBaseline(stats, measure(13), "本文/999.txt", NOON);
    expect(same).toBe(stats);
  });
});

describe("保存の順番で今日の字数が変わらない", () => {
  // 13字の話に、最後の1字（。）を打って保存する。本体の保存が、その1字が文書へ届く前に
  // 走ると、ディスクはまだ13字のまま。あとから［保存］で14字になる。
  const bodyFirst = [13, 14];
  const afterTyped = [14];

  test("開いたときに起点を置けば、どちらの順でも +1字", () => {
    for (const saves of [bodyFirst, afterTyped]) {
      let stats = placeOpenBaseline(emptyDeviceStats("d"), measure(13), A, NOON);
      for (const net of saves) {
        stats = recordMeasurement(stats, measure(net), { at: NOON }).stats;
      }
      expect(todayNet(stats)).toBe(1);
    }
  });

  test("（これまでの不具合）起点を最初の保存で置くと、順番で1字ずれた", () => {
    const run = (saves: number[]): number => {
      let stats = emptyDeviceStats("d");
      for (const net of saves) stats = recordMeasurement(stats, measure(net), { at: NOON }).stats;
      return todayNet(stats);
    };
    expect(run(bodyFirst)).toBe(1);
    expect(run(afterTyped)).toBe(0);
  });

  test("取り込み（rebaseline）は今までどおり、置き直したあとの差だけ数える", () => {
    let stats = placeOpenBaseline(emptyDeviceStats("d"), measure(13), A, NOON);
    stats = rebaseline(stats, measure(5000), NOON);
    const result = recordMeasurement(stats, measure(5003), { at: NOON });
    expect(result.delta).toBe(3);
  });
});

describe("その日に1回だけ置く（日付をまたいだら置き直す）", () => {
  test("同じ日に開き直しても通らない。日が変われば通る", () => {
    const gate = new OpenDayGate();
    expect(gate.claim("w\u0000a", "2026-11-12")).toBe(true);
    expect(gate.claim("w\u0000a", "2026-11-12")).toBe(false);
    expect(gate.claim("w\u0000b", "2026-11-12")).toBe(true);
    expect(gate.claim("w\u0000a", "2026-11-13")).toBe(true);
  });

  test("置けなかったときは忘れて、次に開いたとき置き直す", () => {
    const gate = new OpenDayGate();
    gate.claim("k", "2026-11-12");
    gate.release("k");
    expect(gate.claim("k", "2026-11-12")).toBe(true);
  });

  test("日付をまたいだ置き直しは、記録（昨日の分）を動かさない", () => {
    let stats = placeOpenBaseline(emptyDeviceStats("d"), measure(13), A, NOON);
    stats = recordMeasurement(stats, measure(20), { at: NOON }).stats;
    const midnight = new Date("2026-11-13T04:00:00+09:00");
    const next = placeOpenBaseline(stats, measure(20), A, midnight);
    expect(next.days).toEqual(stats.days);
    expect(sumRange(next.days, "2026-11-12", "2026-11-12").net).toBe(7);
  });
});
