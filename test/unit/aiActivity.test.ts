import { beforeEach, describe, expect, test } from "vitest";
import {
  beginAiWork,
  endAiWork,
  isAiBusy,
  resetAiActivity,
  withAiWork,
} from "../../src/core/aiActivity";

/**
 * AIが仕事中かどうか。独り言が割り込まないための印。
 */
describe("AIの仕事中の印", () => {
  beforeEach(() => resetAiActivity());

  test("何もしていなければ空いている", () => {
    expect(isAiBusy()).toBe(false);
  });

  test("依頼の間だけ仕事中になる", async () => {
    const promise = withAiWork(async () => {
      expect(isAiBusy()).toBe(true);
      return 1;
    });

    expect(await promise).toBe(1);
    expect(isAiBusy()).toBe(false);
  });

  test("失敗しても印を降ろす", async () => {
    // 降ろし忘れると、以後ずっと独り言が出なくなる
    await expect(
      withAiWork(async () => {
        throw new Error("失敗");
      })
    ).rejects.toThrow("失敗");

    expect(isAiBusy()).toBe(false);
  });

  test("並行して投げても、全部終わるまで仕事中のまま", () => {
    // 抽出はチャンクを並行して投げる。真偽値で持つと、
    // 先に終わった1本が「もう空いた」と言ってしまう
    beginAiWork();
    beginAiWork();
    endAiWork();

    expect(isAiBusy()).toBe(true);

    endAiWork();
    expect(isAiBusy()).toBe(false);
  });

  test("合わない降ろし方をされても壊れない", () => {
    // 「ずっと空いている」ことにして黙るより害が小さい
    endAiWork();
    endAiWork();

    expect(isAiBusy()).toBe(false);
    beginAiWork();
    expect(isAiBusy()).toBe(true);
  });
});
