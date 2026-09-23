import { afterEach, describe, expect, test, vi } from "vitest";
import { LOOP_LAG_LIMIT_MS, startLoopLagMeter } from "../../src/core/loopLag";

/**
 * **イベントループが握られていたかを測る**（設計書6.107。0.74.11）。
 *
 * 0.74.9 の計測は `走査 合計 58,844ms（読み 58,191／数え 331／解析 261）`
 * だった。数え・解析は合わせて0.6秒なので走査の計算は重くないのに、
 * 同じ機械で Node に直接読ませると698ファイルで255msで終わる。
 *
 * **読み口が遅いのか、`await` が返ったあと再開できずにいるのか**を
 * 決めるために、一定の間隔で刻んで「予定よりどれだけ遅れたか」を足す。
 *
 * ここで確かめるのは**足し算だけ**である。実際に何ミリ秒遅れるかは
 * 機械しだいなので、**時計を自分で進めて**数える。
 */
describe("イベントループの遅れ", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("遅れが無ければ、合計も最大も0", () => {
    vi.useFakeTimers();
    // **時計は自分で進める。** `setTimeout` が呼ばれた瞬間に、こちらが
    // 決めた時刻が読まれる（実際の速さに結果を左右させない）
    let clock = 0;
    const meter = startLoopLagMeter(50, () => clock);

    for (let i = 1; i <= 3; i++) {
      clock = 50 * i;
      vi.advanceTimersByTime(50);
    }
    const report = meter.stop();

    expect(report.ticks).toBe(3);
    expect(report.totalLagMs).toBe(0);
    expect(report.maxLagMs).toBe(0);
  });

  test("1回だけ100ms遅れれば、合計100・最大100", () => {
    vi.useFakeTimers();
    let clock = 0;
    const meter = startLoopLagMeter(50, () => clock);

    // 1回目は予定どおり（50msで戻ってきた）
    clock = 50;
    vi.advanceTimersByTime(50);
    // 2回目は150msかかった＝**頼んだ50msより100ms遅い**
    clock = 200;
    vi.advanceTimersByTime(50);
    // 3回目はまた予定どおり。遅れは積み増されない
    clock = 250;
    vi.advanceTimersByTime(50);
    const report = meter.stop();

    expect(report.ticks).toBe(3);
    expect(report.totalLagMs).toBe(100);
    expect(report.maxLagMs).toBe(100);
  });

  test("止め忘れても、上限で自分から止まる", () => {
    /*
      **50msごとの目覚ましが鳴り続けるのを避ける。** 止めるのは
      「作品一覧の初回描画」だが、サイドバーを一度も開かない起動では
      合図が来ない（`core/maintenanceTrigger.ts` と同じ抜け方）。
    */
    vi.useFakeTimers();
    let clock = 0;
    const meter = startLoopLagMeter(50, () => clock);

    clock = LOOP_LAG_LIMIT_MS;
    vi.advanceTimersByTime(50);
    const ticksAtLimit = meter.stop().ticks;
    // 上限のあとは、いくら時間を進めても刻まない
    clock = LOOP_LAG_LIMIT_MS + 10_000;
    vi.advanceTimersByTime(10_000);

    expect(ticksAtLimit).toBe(1);
    expect(meter.stop().ticks).toBe(1);
  });

  test("二度止めても、同じ数字を返す", () => {
    // 止めたあとにまた数え始めると、止めた時点の数字が読めなくなる
    vi.useFakeTimers();
    let clock = 0;
    const meter = startLoopLagMeter(50, () => clock);

    clock = 200;
    vi.advanceTimersByTime(50);
    const first = meter.stop();
    clock = 5_000;
    const second = meter.stop();

    expect(second.totalLagMs).toBe(first.totalLagMs);
    expect(second.ticks).toBe(first.ticks);
  });
});
