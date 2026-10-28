import { describe, expect, test } from "vitest";
import { runSerialized } from "../../../src/core/ledgerQueue";
import {
  describeLockRange,
  editingQueueKey,
  planShareSource,
} from "../../../src/core/editingRepo";

describe("順番待ちの鎖", () => {
  test("同じ鍵の仕事は重ならずに、呼んだ順に1本ずつ走る", async () => {
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      order.push(`${name}:始`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name}:終`);
      return name;
    };
    const results = await Promise.all([
      runSerialized("k", task("a", 30)),
      runSerialized("k", task("b", 1)),
      runSerialized("k", task("c", 1)),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["a:始", "a:終", "b:始", "b:終", "c:始", "c:終"]);
  });

  test("鍵が違えば並んで走る", async () => {
    const order: string[] = [];
    await Promise.all([
      runSerialized("x", async () => {
        order.push("x:始");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("x:終");
      }),
      runSerialized("y", async () => {
        order.push("y:始");
        order.push("y:終");
      }),
    ]);
    expect(order.indexOf("y:終")).toBeLessThan(order.indexOf("x:終"));
  });

  test("前の仕事が失敗しても、次は走る（失敗は前の呼び手に返る）", async () => {
    const failing = runSerialized("f", async () => {
      throw new Error("壊れた");
    });
    const next = runSerialized("f", async () => "続き");
    await expect(failing).rejects.toThrow("壊れた");
    await expect(next).resolves.toBe("続き");
  });

  test("編集用フォルダーの鍵は、書き方の違う同じ場所で同じになる", () => {
    expect(editingQueueKey("C:\\Novels\\編集部\\氷の街-編集用")).toBe(
      editingQueueKey("C:/Novels/編集部/氷の街-編集用")
    );
  });
});

describe("渡す送り先の用意（別の機械から渡したとき、2つ目を作らない）", () => {
  test("この機械に編集用フォルダーがあれば、それを使う", () => {
    expect(
      planShareSource({ pointerFolderExists: true, rememberedRemoteUrl: "https://github.com/a/b.git" })
    ).toBe("reuse");
  });
  test("無くても送り先の URL が覚えてあれば、取り寄せて使う（作らない）", () => {
    expect(
      planShareSource({ pointerFolderExists: false, rememberedRemoteUrl: "https://github.com/a/b.git" })
    ).toBe("clone");
  });
  test("どちらも無いときだけ、新しく作る", () => {
    expect(planShareSource({ pointerFolderExists: false, rememberedRemoteUrl: undefined })).toBe(
      "create"
    );
  });
});

describe("校閲中の範囲の言い方", () => {
  test("話数が読めるときは「第N話〜第M話」", () => {
    expect(describeLockRange(["本文/第3話_雪.txt", "本文/第5話_雨.txt", "本文/第4話_風.txt"])).toBe(
      "第3話〜第5話"
    );
  });
  test("1話だけなら「第N話」", () => {
    expect(describeLockRange(["本文/第7話_雪.txt"])).toBe("第7話");
  });
  test("話数が読めない名前が混ざるときは、ファイル名で言う", () => {
    expect(describeLockRange(["本文/あとがき.txt"])).toBe("あとがき.txt");
  });
});
