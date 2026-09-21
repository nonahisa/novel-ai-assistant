import { describe, expect, it } from "vitest";
import { beginStartupTiming } from "../../src/core/startupTiming";

/**
 * 起動の所要時間の計測（設計書6.107）。
 *
 * 作者の機械では、メニューや作品一覧が出るまでに10秒以上かかる。
 * **当てずっぽうで直さない**ために、まず数字を残す。
 *
 * `activate` は単体で動かせないので、ここで確かめられるのは
 * 「印の覚え方」と「1行の組み方」だけである。印をどこに打ったかは
 * `src/extension.ts` を読んで確かめる。
 */

/** 決められた時刻を順に返す時計。テストが実時間に左右されないようにする */
function fakeClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

describe("起動の所要時間", () => {
  it("印を打った順に、入口からの累積で並べる", () => {
    // 入口=0、以降は 120 / 340 / 2800
    const timing = beginStartupTiming(fakeClock([0, 120, 340, 2800]));
    timing.mark("登録簿");
    timing.mark("画面の登録");
    timing.mark("作品一覧の初回描画");

    expect(timing.report()).toBe(
      "起動の所要時間：登録簿 120ms → 画面の登録 340ms → 作品一覧の初回描画 2,800ms"
    );
  });

  it("入口が0でなくても、入口からの経過で数える", () => {
    // `performance.now()` は0から始まるとは限らない
    const timing = beginStartupTiming(fakeClock([5000, 5120, 5340]));
    timing.mark("登録簿");
    timing.mark("画面の登録");

    expect(timing.report()).toBe(
      "起動の所要時間：登録簿 120ms → 画面の登録 340ms"
    );
  });

  it("同じ印を2回打っても、最初の1回だけ残る", () => {
    // 作品一覧は描き直されるたびに getChildren を通る。
    // 2回目で上書きすると「初回の描画」が測れなくなる
    const timing = beginStartupTiming(fakeClock([0, 2800, 9900]));
    timing.mark("作品一覧の初回描画");
    timing.mark("作品一覧の初回描画");

    expect(timing.report()).toBe("起動の所要時間：作品一覧の初回描画 2,800ms");
  });

  it("3桁区切りで書く（万を超えても区切る）", () => {
    const timing = beginStartupTiming(fakeClock([0, 14000, 1234567]));
    timing.mark("点検 終了");
    timing.mark("activate 終了");

    expect(timing.report()).toBe(
      "起動の所要時間：点検 終了 14,000ms → activate 終了 1,234,567ms"
    );
  });

  it("端数は四捨五入して整数で書く", () => {
    const timing = beginStartupTiming(fakeClock([0, 119.6]));
    timing.mark("登録簿");

    expect(timing.report()).toBe("起動の所要時間：登録簿 120ms");
  });

  it("印が1つも無ければ、記録が無いことを書く", () => {
    // 空行を残しても、読んだ人は「書き損ねた」のか「早かった」のか分からない
    const timing = beginStartupTiming(fakeClock([0]));

    expect(timing.report()).toBe("起動の所要時間：記録がありません");
  });

  it("点検が終わらなかったときは、未了の印がそのまま並ぶ", () => {
    // 回線が遅いと点検の終了が来ない。10秒で見切って書き出す（extension.ts 側）
    const timing = beginStartupTiming(fakeClock([0, 2800, 3000, 13000]));
    timing.mark("作品一覧の初回描画");
    timing.mark("点検 開始");
    timing.mark("点検 未了");

    expect(timing.report()).toBe(
      "起動の所要時間：作品一覧の初回描画 2,800ms → 点検 開始 3,000ms → 点検 未了 13,000ms"
    );
  });
});
