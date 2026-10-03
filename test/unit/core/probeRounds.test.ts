import { describe, expect, it } from "vitest";
import { describeProbeProgress, maxProbeRounds } from "../../../src/core/probeRounds";
import {
  describeOutputTimeoutSkip,
  nextOutputProbeSize,
  startOutputProbeState,
  type OutputProbeState,
} from "../../../src/core/outputProbe";
import { nextProbeSize, startProbeState } from "../../../src/core/contextProbe";

/**
 * AIチューニングの進み具合に「あと最大N回」を出す（作者の裁定、2026-10-03。
 * 設計書6.49.3）。
 *
 * 実機（2026-09-06）では測定全体に33分かかり、時間切れ1回につき300秒
 * 待つあいだ、あと何回で終わるのかが分からなかった。
 */
describe("あと最大何回か", () => {
  /** 実際に結果を当てはめて回した回数が、見込みを超えないこと */
  function simulate(
    start: OutputProbeState,
    fits: (lines: number) => boolean
  ): { rounds: number; maxSeen: number[] } {
    let state: OutputProbeState | undefined = start;
    let rounds = 0;
    const maxSeen: number[] = [];
    while (state) {
      // その回を含めた残りの見込み
      maxSeen.push(rounds + maxProbeRounds(state, nextOutputProbeSize));
      rounds += 1;
      state = nextOutputProbeSize(state, fits(state.current));
    }
    return { rounds, maxSeen };
  }

  it("どんな結果になっても、見込みの回数を超えない（書ける量）", () => {
    for (const limit of [0, 50, 100, 1500, 2123, 4146, 8000, 8192]) {
      const { rounds, maxSeen } = simulate(
        startOutputProbeState(8192),
        (lines) => lines <= limit
      );
      for (const bound of maxSeen) expect(rounds).toBeLessThanOrEqual(bound);
    }
  });

  it("見込みは回が進むごとに増えない", () => {
    const { maxSeen } = simulate(startOutputProbeState(8192), (lines) => lines <= 1500);
    for (let index = 1; index < maxSeen.length; index += 1) {
      expect(maxSeen[index]).toBeLessThanOrEqual(maxSeen[index - 1]);
    }
  });

  it("終わった状態は0回", () => {
    expect(
      maxProbeRounds(undefined as OutputProbeState | undefined, nextOutputProbeSize)
    ).toBe(0);
  });

  it("進み具合の一文：このあと何回か。最後の回はそう言う", () => {
    expect(describeProbeProgress(2, 5)).toBe("（2回目・このあと最大4回。測り直しを除く）");
    expect(describeProbeProgress(6, 1)).toBe("（6回目・これが最後の見込み）");
  });

  it("読める長さの探索にも同じ形で使える", () => {
    const start = startProbeState(200_000);
    expect(maxProbeRounds(start, nextProbeSize)).toBeGreaterThan(1);
  });
});

/**
 * 時間切れになった長さより上は試さない（作者の裁定、2026-10-03）。
 * 書ける量の探索は、書き切れなかった（時間切れを含む）行数を上の端に
 * するので、そこより長くは頼まない。ここではそれを決まりとして固める。
 */
describe("時間切れになった量より上は頼まない", () => {
  it("8192行で書き切れなかったら、それ以降は8192行未満しか頼まない", () => {
    let state: OutputProbeState | undefined = startOutputProbeState(8192);
    // 1回目（100行）は書けた
    state = nextOutputProbeSize(state, true);
    expect(state?.current).toBe(8192);
    let failedAt = state!.current;
    state = nextOutputProbeSize(state!, false);
    while (state) {
      expect(state.current).toBeLessThan(failedAt);
      const ok = state.current <= 1000;
      if (!ok) failedAt = Math.min(failedAt, state.current);
      state = nextOutputProbeSize(state, ok);
    }
  });

  it("結果の一文で、測れなかった量と試さなかった量を分けて言う", () => {
    expect(describeOutputTimeoutSkip(2123)).toBe(
      "2,123 行は時間切れで測れず、それより長い量は試していません。"
    );
    expect(describeOutputTimeoutSkip(undefined)).toBe("");
  });
});
