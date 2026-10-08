import { describe, expect, test } from "vitest";
import { TurnQueue, TurnWaitAbortedError } from "../../../src/core/runningCommands";

/**
 * 順番待ちの列（作者の裁定 2026-10-05「断らずに、終わるまで待ってから始める」）。
 *
 * 索引づくり（設計書6.87.23）が使う。ここでは振る舞いだけを固定する——
 * 「同時に1つ」「先に頼んだものが先」「待っている間も中止できる」「中止しても列が壊れない」。
 */

/** 次のマイクロタスクまで待つ（「まだ進んでいない」ことを見るのに要る） */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("順番待ちの列", () => {
  test("先客がいる間、2つ目は待たされ、先客が返すと入る", async () => {
    const queue = new TurnQueue();
    const first = await queue.acquire("星の町");
    expect(queue.currentLabel()).toBe("星の町");

    let secondEntered = false;
    const second = queue.acquire("海の駅").then((release) => {
      secondEntered = true;
      return release;
    });
    await settle();
    expect(secondEntered).toBe(false);
    expect(queue.pending()).toBe(1);

    first();
    const releaseSecond = await second;
    expect(secondEntered).toBe(true);
    expect(queue.currentLabel()).toBe("海の駅");
    releaseSecond();
    expect(queue.currentLabel()).toBeUndefined();
  });

  test("先に頼んだものが先に入る", async () => {
    const queue = new TurnQueue();
    const order: string[] = [];
    const first = await queue.acquire("1");
    const b = queue.acquire("2").then((release) => {
      order.push("2");
      release();
    });
    const c = queue.acquire("3").then((release) => {
      order.push("3");
      release();
    });
    first();
    await Promise.all([b, c]);
    expect(order).toEqual(["2", "3"]);
  });

  test("待っている間に中止すると列から抜け、先客も後の人も困らない", async () => {
    const queue = new TurnQueue();
    const first = await queue.acquire("1");
    const controller = new AbortController();
    const aborted = queue.acquire("2", controller.signal);
    const third = queue.acquire("3");

    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(TurnWaitAbortedError);
    expect(queue.pending()).toBe(1);
    expect(queue.currentLabel()).toBe("1");

    first();
    const releaseThird = await third;
    expect(queue.currentLabel()).toBe("3");
    releaseThird();
  });

  test("始める前から中止されていれば、並ばずに断る", async () => {
    const queue = new TurnQueue();
    const controller = new AbortController();
    controller.abort();
    await expect(queue.acquire("1", controller.signal)).rejects.toBeInstanceOf(
      TurnWaitAbortedError
    );
    expect(queue.currentLabel()).toBeUndefined();
  });

  test("返す関数を2度呼んでも、2人を一度に通さない", async () => {
    const queue = new TurnQueue();
    const first = await queue.acquire("1");
    const second = queue.acquire("2");
    const third = queue.acquire("3");
    first();
    first();
    await second;
    await settle();
    expect(queue.currentLabel()).toBe("2");
    expect(queue.pending()).toBe(1);
    void third;
  });
});
