import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import type * as vscode from "vscode";
import type { WorkRegistry } from "../../../src/core/workRegistry";

/**
 * スケジュールの知らせは**1日1回だけ**（設計書6.111.9。実機確認リストの
 * 「ターゲット読者の仕上げ」の最後の項目を機械で見る）。
 *
 * 近づいた予定をどう数えて1文にするかは `scheduleBoard.test.ts` の「知らせ」が
 * 見ている。ここは**いつ・何回出すか**だけを見る——起動の少しあとに1回、
 * 同じ日には2度出さない（窓を2つ開いても）、日が替われば出す、設定で切れる。
 */

const state = vi.hoisted(() => ({
  today: "2026-09-24",
  text: "スケジュール：今日始める段が1つ" as string | null,
  boardLoads: 0,
}));

vi.mock("../../../src/features/scheduleData", () => ({
  scheduleToday: () => state.today,
  loadScheduleBoard: vi.fn(async () => {
    state.boardLoads++;
    return { columns: [], today: state.today };
  }),
}));

vi.mock("../../../src/features/holidayImport", () => ({
  loadHolidays: vi.fn(async () => new Set<string>()),
}));

vi.mock("../../../src/core/scheduleNotice", () => ({
  collectScheduleNotices: () => ({}),
  scheduleNoticeText: () => state.text,
}));

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  useLogFile: vi.fn(),
}));

import { startScheduleNotices } from "../../../src/features/scheduleNotify";

/** 同じ機械の窓どうしで共有される記憶（`globalState`）の代役 */
function sharedGlobalState(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      (values.has(key) ? values.get(key) : defaultValue) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      values.set(key, value);
    },
  } as vscode.Memento;
}

/** 1つの窓。閉じるときは `close` で見張りを止める */
function openWindow(globalState: vscode.Memento): { close: () => void } {
  const subscriptions: { dispose(): void }[] = [];
  startScheduleNotices(
    { globalState, subscriptions } as unknown as vscode.ExtensionContext,
    {} as WorkRegistry,
    "device-1"
  );
  return {
    close: () => {
      for (const item of subscriptions) item.dispose();
    },
  };
}

let shown: string[] = [];
let notifySetting = true;

beforeEach(() => {
  vi.useFakeTimers();
  shown = [];
  notifySetting = true;
  state.today = "2026-09-24";
  state.text = "スケジュール：今日始める段が1つ";
  state.boardLoads = 0;
  window.showInformationMessage = (async (message: string) => {
    shown.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, defaultValue: T): T =>
      key === "schedule.notify" ? (notifySetting as T) : defaultValue,
  })) as typeof workspace.getConfiguration;
});

afterEach(() => {
  vi.useRealTimers();
  workspace.getConfiguration = () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  });
});

/** 起動の少しあと（20秒）まで進める */
async function passStartupDelay(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20_000);
}

/** 日付を見に来る間隔（30分）ぶん進める */
async function passDayCheck(): Promise<void> {
  await vi.advanceTimersByTimeAsync(30 * 60_000);
}

describe("スケジュールの知らせは1日1回だけ", () => {
  test("起動の少しあとに1回出し、同じ日のうちは30分ごとに見に来ても出さない", async () => {
    const view = openWindow(sharedGlobalState());
    // 起動の重い時間帯には走査しない
    await vi.advanceTimersByTimeAsync(19_000);
    expect(shown).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(shown).toEqual(["スケジュール：今日始める段が1つ"]);

    await passDayCheck();
    await passDayCheck();
    expect(shown).toHaveLength(1);
    view.close();
  });

  test("**窓を2つ開いていても、同じ日に2度出さない**", async () => {
    const globalState = sharedGlobalState();
    const first = openWindow(globalState);
    await passStartupDelay();
    expect(shown).toHaveLength(1);

    const second = openWindow(globalState);
    await passStartupDelay();
    expect(shown).toHaveLength(1);
    // あとから開いた窓は作品を走査し直さない
    expect(state.boardLoads).toBe(1);
    first.close();
    second.close();
  });

  test("日が替われば、また出す", async () => {
    const view = openWindow(sharedGlobalState());
    await passStartupDelay();
    expect(shown).toHaveLength(1);

    state.today = "2026-09-25";
    state.text = "スケジュール：締切が近い予定が1つ";
    await passDayCheck();
    expect(shown).toEqual([
      "スケジュール：今日始める段が1つ",
      "スケジュール：締切が近い予定が1つ",
    ]);
    view.close();
  });

  test("何も無い日は出さず、その日はもう確かめない", async () => {
    state.text = null;
    const globalState = sharedGlobalState();
    const first = openWindow(globalState);
    await passStartupDelay();
    expect(shown).toEqual([]);

    // 同じ日に予定が増えても、その日は確かめ済み（翌日に出る）
    state.text = "スケジュール：今日始める段が1つ";
    const second = openWindow(globalState);
    await passStartupDelay();
    expect(shown).toEqual([]);
    expect(state.boardLoads).toBe(1);
    first.close();
    second.close();
  });

  test("設定 `novelai.schedule.notify` を切ると出ない（作品も走査しない）", async () => {
    notifySetting = false;
    const view = openWindow(sharedGlobalState());
    await passStartupDelay();
    await passDayCheck();
    expect(shown).toEqual([]);
    expect(state.boardLoads).toBe(0);
    view.close();
  });

  test("切っていた日に入れ直すと、翌日からまた出る", async () => {
    notifySetting = false;
    const view = openWindow(sharedGlobalState());
    await passStartupDelay();
    expect(shown).toEqual([]);

    notifySetting = true;
    state.today = "2026-09-25";
    await passDayCheck();
    expect(shown).toEqual(["スケジュール：今日始める段が1つ"]);
    view.close();
  });
});
