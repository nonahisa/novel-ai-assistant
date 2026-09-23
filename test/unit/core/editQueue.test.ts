import { describe, expect, it } from "vitest";
import { createEditQueue } from "../../src/core/editQueue";

/**
 * 打たれた本文を1つずつ順に当てる（設計書6.25.2）。
 *
 * 作者の指摘（2026-08-24）：「改行した際に勝手に空行が入ります」。
 *
 * **当てている間に次が届くと、どちらも同じ「いまの文書」と見比べる。**
 * 同じ差分が2回当たり、改行が2つ入っていた。
 */

/** 好きなときに終わらせられる処理 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("順番待ち", () => {
  it("当て終わるまで、次を当てない", async () => {
    const running: string[] = [];
    const done: string[] = [];
    const gate = deferred();

    const queue = createEditQueue(async (text) => {
      running.push(text);
      await gate.promise;
      done.push(text);
    });

    void queue("あ");
    void queue("あい");
    await Promise.resolve();

    // 1つ目が終わっていないので、2つ目はまだ始まらない
    expect(running).toEqual(["あ"]);
    expect(done).toEqual([]);

    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toContain("あ");
  });

  /** ここが「空行が2つ入る」の防ぎ */
  it("待っている間に届いたものは、最後の1つに畳む", async () => {
    const applied: string[] = [];
    const gate = deferred();
    let first = true;

    const queue = createEditQueue(async (text) => {
      applied.push(text);
      if (first) {
        first = false;
        await gate.promise;
      }
    });

    void queue("あ");
    await Promise.resolve();
    void queue("あい");
    void queue("あいう");
    void queue("あいうえ");

    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // 途中の「あい」「あいう」は当てない。行き着く先は同じ
    expect(applied).toEqual(["あ", "あいうえ"]);
  });

  it("順番に呼べば、順番に当たる", async () => {
    const applied: string[] = [];
    const queue = createEditQueue(async (text) => {
      applied.push(text);
    });

    await queue("あ");
    await queue("あい");
    await queue("あいう");

    expect(applied).toEqual(["あ", "あい", "あいう"]);
  });

  /** 当てるのに失敗したまま止まると、それ以降いっさい打てなくなる */
  it("当てるのに失敗しても、次から打てる", async () => {
    const applied: string[] = [];
    let failNext = true;
    const queue = createEditQueue(async (text) => {
      if (failNext) {
        failNext = false;
        throw new Error("当てられなかった");
      }
      applied.push(text);
    });

    await expect(queue("あ")).rejects.toThrow();
    await queue("あい");

    expect(applied).toEqual(["あい"]);
  });

  it("何も届かなければ、何も当てない", async () => {
    const applied: string[] = [];
    createEditQueue(async (text) => {
      applied.push(text);
    });
    expect(applied).toEqual([]);
  });
});
