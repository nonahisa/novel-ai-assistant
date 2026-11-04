import { describe, expect, test } from "vitest";
import { mapLimit } from "../../../src/core/mapLimit";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapLimit", () => {
  test("結果は入力の並びのまま（遅く終わるものが先頭でも）", async () => {
    const result = await mapLimit([30, 1, 10], 3, async (ms, i) => {
      await sleep(ms);
      return `${i}:${ms}`;
    });
    expect(result).toEqual(["0:30", "1:1", "2:10"]);
  });

  test("同時に走る数は上限を超えない", async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(5);
      running -= 1;
    });
    expect(peak).toBe(4);
  });

  test("空でも、上限が0や負でも動く", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit([1, 2], 0, async (x) => x * 2)).toEqual([2, 4]);
  });

  test("失敗は全体の失敗になり、まだ始めていない分は始めない", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5], 1, async (x) => {
        started.push(x);
        if (x === 1) throw new Error("boom");
        return x;
      })
    ).rejects.toThrow("boom");
    expect(started).toEqual([0, 1]);
  });
});
