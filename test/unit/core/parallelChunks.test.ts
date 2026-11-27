import { describe, expect, test } from "vitest";
import {
  CLOUD_CONCURRENT_CHUNKS,
  concurrentChunksFor,
  runOrderedQueue,
} from "../../../src/core/parallelChunks";

/**
 * チャンクを同時に送る輪（設計書6.76.2）。
 *
 * 見張ること：
 * - 終わる順がばらばらでも、**受け取りはチャンクの順**（指摘の並びが変わらない）
 * - 同時に走るのは幅まで。**幅1なら「送る → 受け取る → 次を送る」**（手元のAIの道）
 * - 止めたら新しく送らない。**終わっている分は受け取る**
 * - 分け直した分は親の直後へ入る
 * - 待ち（レート上限）のあいだは新しく送らない
 */

/** 手で終わらせられる約束 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("同時に送る数", () => {
  test("手元のAI（Ollama・LM Studio）は1つずつ、クラウドは3つまで", () => {
    expect(CLOUD_CONCURRENT_CHUNKS).toBe(3);
    expect(concurrentChunksFor("ollama")).toBe(1);
    expect(concurrentChunksFor("lmstudio")).toBe(1);
    expect(concurrentChunksFor("claude")).toBe(3);
    expect(concurrentChunksFor("sakura")).toBe(3);
    // 知らないIDはクラウド扱い（`isLocalProviderId` と同じ倒し方）
    expect(concurrentChunksFor("someday-new-cloud")).toBe(3);
  });
});

describe("並びを保ったまま同時に送る", () => {
  test("後ろのチャンクが先に終わっても、受け取りはチャンクの順", async () => {
    const settled: number[] = [];
    let running = 0;
    let maxRunning = 0;
    // 先頭ほど遅く終わる
    const delays = [40, 30, 20, 10, 5, 1];
    await runOrderedQueue([0, 1, 2, 3, 4, 5], {
      concurrency: 3,
      canStart: () => true,
      send: async (item) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, delays[item]));
        running--;
        return item * 10;
      },
      settle: (item, result) => {
        expect(result).toBe(item * 10);
        settled.push(item);
      },
    });
    expect(settled).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxRunning).toBe(3);
  });

  test("幅1なら、受け取りが済むまで次を送らない（従来の順送り）", async () => {
    const events: string[] = [];
    let running = 0;
    let maxRunning = 0;
    await runOrderedQueue(["a", "b", "c"], {
      concurrency: 1,
      canStart: () => true,
      send: async (item) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        events.push(`送る ${item}`);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        return item;
      },
      settle: (item) => {
        events.push(`受け取る ${item}`);
      },
    });
    expect(maxRunning).toBe(1);
    expect(events).toEqual([
      "送る a",
      "受け取る a",
      "送る b",
      "受け取る b",
      "送る c",
      "受け取る c",
    ]);
  });

  test("幅1で受け取りが止めの旗を立てたら、次は送らない", async () => {
    const sent: string[] = [];
    let stop = false;
    await runOrderedQueue(["a", "b", "c"], {
      concurrency: 1,
      canStart: () => !stop,
      send: async (item) => {
        sent.push(item);
        return item;
      },
      settle: () => {
        stop = true;
      },
    });
    expect(sent).toEqual(["a"]);
  });

  test("分け直した分は親の直後へ入り、後ろのチャンクより先に受け取る", async () => {
    const settled: string[] = [];
    await runOrderedQueue(["A", "B", "C"], {
      concurrency: 3,
      canStart: () => true,
      send: async (item) => {
        // B と C は A より先に終わる
        await new Promise((r) => setTimeout(r, item === "A" ? 20 : 1));
        return item;
      },
      settle: (item) => {
        settled.push(item);
        if (item === "A") return ["A1", "A2"];
        return undefined;
      },
    });
    expect(settled).toEqual(["A", "A1", "A2", "B", "C"]);
  });
});

describe("中止したとき", () => {
  test("新しく送らない。終わっている分は受け取り、送信中の分は結果を渡す", async () => {
    const sent: number[] = [];
    const settled: Array<[number, string]> = [];
    const gates = [0, 1, 2, 3, 4, 5].map(() => deferred<string>());
    let cancelled = false;
    const run = runOrderedQueue([0, 1, 2, 3, 4, 5], {
      concurrency: 3,
      canStart: () => !cancelled,
      send: async (item) => {
        sent.push(item);
        return await gates[item].promise;
      },
      settle: (item, result) => {
        settled.push([item, result]);
      },
    });
    await flush();
    expect(sent).toEqual([0, 1, 2]);
    // 2番目が先に終わる（先頭がまだなので受け取りは待つ）。空いた枠へ 3 が送られる
    gates[1].resolve("済");
    await flush();
    expect(sent).toEqual([0, 1, 2, 3]);
    // ここで中止。送信中の 0・2・3 は「捨てた」という結果で返ってくる
    cancelled = true;
    gates[0].resolve("捨てた");
    gates[2].resolve("捨てた");
    gates[3].resolve("捨てた");
    await run;

    // 4・5 は送らない。終わっていた 1 の結果は並びの位置で受け取る
    expect(sent).toEqual([0, 1, 2, 3]);
    expect(settled).toEqual([
      [0, "捨てた"],
      [1, "済"],
      [2, "捨てた"],
      [3, "捨てた"],
    ]);
  });

  test("先頭が終わらないまま止めても、後ろの終わった分は受け取る", async () => {
    const settled: number[] = [];
    let stop = false;
    const first = deferred<number>();
    const run = runOrderedQueue([0, 1, 2], {
      concurrency: 3,
      canStart: () => !stop,
      send: async (item) => (item === 0 ? await first.promise : item),
      settle: (item) => {
        settled.push(item);
      },
    });
    await flush();
    expect(settled).toEqual([]);
    stop = true;
    first.resolve(0);
    await run;
    expect(settled).toEqual([0, 1, 2]);
  });
});

describe("待ちのあいだは新しく送らない", () => {
  test("レート上限で待っているあいだ、残りは送らずに待つ", async () => {
    const sent: number[] = [];
    let hold: Promise<void> | undefined;
    const release = deferred<void>();
    const run = runOrderedQueue([0, 1, 2, 3, 4], {
      concurrency: 3,
      canStart: () => true,
      holdBeforeStart: () => hold,
      send: async (item) => {
        sent.push(item);
        if (item === 0) {
          // 1件目が上限に当たって待ちに入った形
          hold = release.promise.then(() => {
            hold = undefined;
          });
          await hold;
        }
        return item;
      },
      settle: () => undefined,
    });
    await flush();
    // 0 が待ちに入ったので、1 以降は送らない
    expect(sent).toEqual([0]);
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toEqual([0]);
    release.resolve();
    await run;
    expect(sent).toEqual([0, 1, 2, 3, 4]);
  });
});
