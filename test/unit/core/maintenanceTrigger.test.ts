import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createMaintenanceTrigger,
  MAINTENANCE_SIGNAL_WAIT_MS,
  MAINTENANCE_TIMEOUT_NOTE,
} from "../../src/core/maintenanceTrigger";

/**
 * **作品フォルダーの整備を、いつ起こすか**（設計書6.107。0.74.9）。
 *
 * 0.74.9 で、整備は「作品一覧の初回描画」の合図を受けてから起こすように
 * した（一覧の走査と同じスレッドで取り合っていたため）。
 *
 * **ところが、合図が来ないことがある。** VS Code が `getChildren` を呼ぶのは
 * ビューが見えたときなので、**サイドバーを一度も開かない起動では合図が
 * 来ない**。そのセッションでは `.gitignore` の移行も「作品フォルダーが
 * 見つかりません」の知らせも出ない——順番の問題ではなく**抜け落ち**である。
 *
 * `activate` は単体で動かせないので、判断だけをここへ出して試験で守る。
 */
describe("整備を起こす合図", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("合図が来たら起こす（注記は付かない）", () => {
    const started: Array<string | undefined> = [];
    const trigger = createMaintenanceTrigger((note) => started.push(note));

    trigger.arm();
    trigger.signal();

    expect(started).toEqual([undefined]);
    expect(trigger.started).toBe(true);
  });

  test("合図が来なければ、上限で起こす（注記を添える）", () => {
    /*
      **印は「整備 開始」のまま、注記で見分ける。** 合図で起きたのなら
      作品一覧は出ているし、上限で起きたのならビューは開かれていない。
      あとから数字を読むとき、この違いで読み方が変わる。
    */
    vi.useFakeTimers();
    const started: Array<string | undefined> = [];
    const trigger = createMaintenanceTrigger((note) => started.push(note));

    trigger.arm();
    // 上限の手前では、まだ起こさない
    vi.advanceTimersByTime(MAINTENANCE_SIGNAL_WAIT_MS - 1);
    expect(started).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(started).toEqual([MAINTENANCE_TIMEOUT_NOTE]);
    expect(trigger.started).toBe(true);
  });

  test("合図と上限の両方が来ても、起こすのは1回だけ", () => {
    /*
      **整備が2回走ると、`.gitignore` の書き込みと知らせが二重になる。**
      どちらが先に来るかは分からないので、両方の順序を確かめる。
    */
    vi.useFakeTimers();

    // ① 合図が先 → そのあと上限の時刻を過ぎても、もう起こさない
    const first: Array<string | undefined> = [];
    const early = createMaintenanceTrigger((note) => first.push(note));
    early.arm();
    early.signal();
    early.signal();
    vi.advanceTimersByTime(MAINTENANCE_SIGNAL_WAIT_MS * 2);
    expect(first).toEqual([undefined]);

    // ② 上限が先 → そのあと合図が来ても、もう起こさない
    const second: Array<string | undefined> = [];
    const late = createMaintenanceTrigger((note) => second.push(note));
    late.arm();
    vi.advanceTimersByTime(MAINTENANCE_SIGNAL_WAIT_MS);
    late.signal();
    late.arm();
    vi.advanceTimersByTime(MAINTENANCE_SIGNAL_WAIT_MS * 2);
    expect(second).toEqual([MAINTENANCE_TIMEOUT_NOTE]);
  });

  test("片付けたら、上限が来ても起こさない（拡張機能が終わるとき）", () => {
    vi.useFakeTimers();
    const started: Array<string | undefined> = [];
    const trigger = createMaintenanceTrigger((note) => started.push(note));

    trigger.arm();
    trigger.dispose();
    vi.advanceTimersByTime(MAINTENANCE_SIGNAL_WAIT_MS * 2);

    expect(started).toEqual([]);
    expect(trigger.started).toBe(false);
  });
});
