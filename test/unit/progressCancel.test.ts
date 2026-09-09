import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { window } from "./support/vscodeStub";
import {
  cancelRunningTask,
  withCancellableProgress,
} from "../../src/views/progress";

/**
 * 中止ボタンは「どれを止めるか」を選べる（設計書6.76、0.33.0のレビュー）。
 *
 * キュー（6.76）を入れてから、一括処理は2つ並ぶようになった。誤字脱字を
 * 回している最中に矛盾検知を押すと、後客は**順番待ちのまま進捗を出す。**
 * 中止できる処理を1本しか覚えていなかった頃は、最後に始めたほう（＝待って
 * いるだけのほう）が中止の宛先になり、**作者が「動いているほうを止めたい」
 * と思って押すと、待っているほうが消えた。** 2度押せば届くが、
 * どちらが止まるかは画面のどこにも出ていない。
 *
 * だから2件以上あるときは選ばせる。**1件だけのときは従来どおり即中止**
 * ——ほとんどの場面はこちらなので、ここに問いを挟むと邪魔になる。
 */

/** 進捗の中で受け取った中止の合図 */
interface RunningTask {
  /** 処理を終わらせる（`withCancellableProgress` から抜ける） */
  finish: () => void;
  /** 処理そのものの完了 */
  done: Promise<void>;
  /** 中止されたか */
  cancelled: () => boolean;
}

function start(title: string): RunningTask {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  let token: vscode.CancellationToken | undefined;
  const done = withCancellableProgress(title, async (_progress, given) => {
    token = given;
    await gate;
  });
  return {
    finish,
    done,
    cancelled: () => token?.isCancellationRequested === true,
  };
}

/** QuickPickに並んだ選択肢。ラベルだけ覚える */
let offered: Array<{ label: string; description?: string }> = [];
/** 何番目を選ぶか。undefined なら Esc（何も選ばない） */
let pickIndex: number | undefined;

const stub = window as unknown as Record<string, unknown>;
const originalWithProgress = stub.withProgress;
const originalShowQuickPick = stub.showQuickPick;

beforeEach(() => {
  offered = [];
  pickIndex = undefined;
  // 本物と同じく、渡された処理をそのまま走らせる
  stub.withProgress = async (
    _options: unknown,
    task: (progress: unknown, token: unknown) => Promise<unknown>
  ) => task({ report: () => undefined }, undefined);
  stub.showQuickPick = async (
    items: Array<{ label: string; description?: string }>
  ) => {
    offered = items;
    return pickIndex === undefined ? undefined : items[pickIndex];
  };
});

afterEach(() => {
  stub.withProgress = originalWithProgress;
  stub.showQuickPick = originalShowQuickPick;
});

describe("中止できる処理が1件のとき", () => {
  test("問わずにその場で止める（従来どおり）", async () => {
    const task = start("誤字脱字を検知しています");

    await cancelRunningTask();

    expect(task.cancelled()).toBe(true);
    // **選ばせない。** 1件しか無いのに問うのは、ただの手間である
    expect(offered).toEqual([]);
    task.finish();
    await task.done;
  });

  test("何も動いていなければ、何も起きない", async () => {
    await expect(cancelRunningTask()).resolves.toBeUndefined();
    expect(offered).toEqual([]);
  });

  test("終わった処理は、もう中止の宛先にならない", async () => {
    const first = start("誤字脱字を検知しています");
    first.finish();
    await first.done;

    const second = start("矛盾を検知しています");
    await cancelRunningTask();

    expect(second.cancelled()).toBe(true);
    expect(offered).toEqual([]);
    second.finish();
    await second.done;
  });
});

describe("中止できる処理が2件のとき", () => {
  test("題を並べて選ばせ、選んだほうだけを止める", async () => {
    const running = start("誤字脱字を検知しています");
    const waiting = start("「誤字脱字の検知」の完了を待っています");

    // 先に始めたほう（動いているほう）を選ぶ
    pickIndex = 0;
    await cancelRunningTask();

    expect(offered.map((item) => item.label).slice(0, 2)).toEqual([
      "誤字脱字を検知しています",
      "「誤字脱字の検知」の完了を待っています",
    ]);
    // 出口を目に見える形で置く（設計書6.17.2）
    expect(offered[offered.length - 1].label).toContain("どれも中止しない");
    expect(running.cancelled()).toBe(true);
    expect(waiting.cancelled()).toBe(false);

    running.finish();
    waiting.finish();
    await Promise.all([running.done, waiting.done]);
  });

  test("あとから始めたほうを選べば、そちらだけが止まる", async () => {
    const running = start("誤字脱字を検知しています");
    const waiting = start("「誤字脱字の検知」の完了を待っています");

    pickIndex = 1;
    await cancelRunningTask();

    expect(running.cancelled()).toBe(false);
    expect(waiting.cancelled()).toBe(true);

    running.finish();
    waiting.finish();
    await Promise.all([running.done, waiting.done]);
  });

  test("Escで閉じたら、どちらも止めない", async () => {
    // **選ばなかったのだから、何も起きないのが正しい。**
    // ここで既定を決めて片方を止めると、作者は「押していないのに消えた」と読む
    const running = start("誤字脱字を検知しています");
    const waiting = start("矛盾を検知しています");

    pickIndex = undefined;
    await cancelRunningTask();

    expect(running.cancelled()).toBe(false);
    expect(waiting.cancelled()).toBe(false);

    running.finish();
    waiting.finish();
    await Promise.all([running.done, waiting.done]);
  });

  test("「どれも中止しない」を選んでも、どちらも止めない", async () => {
    const running = start("誤字脱字を検知しています");
    const waiting = start("矛盾を検知しています");

    // 末尾に置いた出口の項目を選ぶ
    pickIndex = 2;
    await cancelRunningTask();

    expect(running.cancelled()).toBe(false);
    expect(waiting.cancelled()).toBe(false);

    running.finish();
    waiting.finish();
    await Promise.all([running.done, waiting.done]);
  });

  test("同じ題が2つ並んでも、始めた順で見分けられる", async () => {
    const first = start("本文を読み込んでいます");
    const second = start("本文を読み込んでいます");

    pickIndex = 1;
    await cancelRunningTask();

    expect(offered[0].description).not.toBe(offered[1].description);
    expect(first.cancelled()).toBe(false);
    expect(second.cancelled()).toBe(true);

    first.finish();
    second.finish();
    await Promise.all([first.done, second.done]);
  });
});
