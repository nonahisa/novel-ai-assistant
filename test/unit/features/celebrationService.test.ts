import { describe, expect, test, vi } from "vitest";

const failures = vi.hoisted(() => [] as string[]);
vi.mock("../../../src/core/logger", () => ({
  logFailure: (context: string) => {
    failures.push(context);
  },
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

import {
  CelebrationService,
  type CelebrationDeps,
} from "../../../src/features/celebrations";
import type { Achievement } from "../../../src/core/celebrations";
import type { DeviceWritingStats } from "../../../src/models/writingStats";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkGoals } from "../../../src/models/workGoals";

/**
 * 祝う係（設計書6.3.8）。
 *
 * 見るのは3つ——**保存を何度くり返しても一度きり**か、**全作品の合計で
 * 1日の目標を見る**か、**執筆統計で一度見せたら二度は上げない**か。
 */

const workA: WorkEntry = {
  id: "a",
  title: "空の港",
  folderPath: "C:\\novels\\a",
  registeredAt: "2026-08-16T00:00:00.000Z",
};
const workB: WorkEntry = {
  id: "b",
  title: "海の駅",
  folderPath: "C:\\novels\\b",
  registeredAt: "2026-08-16T00:00:00.000Z",
};

const NOW = new Date("2026-09-23T10:00:00");

function statsWith(net: number): DeviceWritingStats[] {
  return [
    {
      schemaVersion: "0.1",
      deviceId: "pc1",
      baseline: null,
      days: [{ date: "2026-09-23", net, gross: net, saves: 1 }],
    } as unknown as DeviceWritingStats,
  ];
}

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T): T =>
      (store.has(key) ? store.get(key) : fallback) as T,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

function setup(overrides: Partial<CelebrationDeps> = {}) {
  const logs = new Map<string, Achievement[]>();
  const perWork = new Map<string, number>([
    ["a", 600],
    ["b", 500],
  ]);
  let goals: WorkGoals = { schemaVersion: "0.1", perEpisodeChars: null, contest: null };
  const settings = { enabled: true, dailyGoal: 1_000, monthlyGoal: 0, boundaryHour: 4 };
  const deps: CelebrationDeps = {
    memento: memento(),
    works: () => [workA, workB],
    loadStats: async (work) => statsWith(perWork.get(work.id) ?? 0),
    loadWorkLog: async (work) => logs.get(work.id) ?? [],
    appendWorkLog: async (work, added) => {
      logs.set(work.id, [...(logs.get(work.id) ?? []), ...added]);
    },
    readGoals: async () => goals,
    settings: () => settings,
    now: () => NOW,
    ...overrides,
  };
  return {
    service: new CelebrationService(deps),
    logs,
    perWork,
    settings,
    setGoals: (next: WorkGoals) => {
      goals = next;
    },
  };
}

describe("1日の目標は全作品の合計で見る", () => {
  test("1作品では届かなくても、全作品の合計で届けば祝う", async () => {
    const { service } = setup();
    const found = await service.afterSave(workA, { wrote: true, written: 600 });
    expect(found.map((entry) => entry.kind)).toEqual(["daily"]);
    expect(found[0].written).toBe(1_100);
  });

  test("何度保存しても、同じ日には一度きり", async () => {
    const { service, perWork } = setup();
    await service.afterSave(workA, { wrote: true, written: 600 });
    perWork.set("a", 900);
    const again = await service.afterSave(workA, { wrote: true, written: 900 });
    expect(again).toEqual([]);
    const fromB = await service.afterSave(workB, { wrote: true, written: 500 });
    expect(fromB).toEqual([]);
  });

  test("目標を変えれば、新しい値で改めて祝う", async () => {
    const { service, settings } = setup();
    await service.afterSave(workA, { wrote: true, written: 600 });
    settings.dailyGoal = 1_050;
    const again = await service.afterSave(workA, { wrote: true, written: 600 });
    expect(again.map((entry) => entry.goal)).toEqual([1_050]);
  });

  test("設定で切っていれば何もしない", async () => {
    const { service, settings } = setup();
    settings.enabled = false;
    expect(await service.afterSave(workA, { wrote: true, written: 600 })).toEqual([]);
    expect(await service.pendingFor(workA)).toBeUndefined();
    expect(await service.cheerFor(workA)).toBeUndefined();
  });

  test("書いて増えた保存でなければ、合計も読みにいかない", async () => {
    const loadStats = vi.fn(async () => statsWith(5_000));
    const { service } = setup({ loadStats });
    expect(await service.afterSave(workA, { wrote: false, written: 600 })).toEqual([]);
    expect(loadStats).not.toHaveBeenCalled();
  });

  test("もう祝った日は、合計を読み直さない（保存のたびに全作品を読まない）", async () => {
    const loadStats = vi.fn(async () => statsWith(600));
    const { service } = setup({ loadStats });
    await service.afterSave(workA, { wrote: true, written: 600 });
    loadStats.mockClear();
    await service.afterSave(workA, { wrote: true, written: 700 });
    expect(loadStats).not.toHaveBeenCalled();
  });
});

describe("作品の目標は作品の記録に残す", () => {
  const contestGoals: WorkGoals = {
    schemaVersion: "0.1",
    perEpisodeChars: null,
    contest: {
      name: "テスト大賞",
      url: null,
      deadline: "2026-09-30",
      minChars: 600,
      maxChars: null,
      dailyGoal: null,
    },
  };

  test("作品の文字量と締切の達成は作品の記録へ、1日は端末の側へ", async () => {
    const { service, logs, setGoals } = setup();
    setGoals(contestGoals);
    const found = await service.afterSave(workA, { wrote: true, written: 600 });
    expect(found.map((entry) => entry.kind).sort()).toEqual([
      "daily",
      "deadline",
      "work",
    ]);
    expect((logs.get("a") ?? []).map((entry) => entry.kind).sort()).toEqual([
      "deadline",
      "work",
    ]);
    // 同期された記録を見て、二度は祝わない
    expect(await service.afterSave(workA, { wrote: true, written: 650 })).toEqual([]);
  });

  test("作品の記録が壊れていたら、作品の目標は祝わず書きもしない", async () => {
    const appendWorkLog = vi.fn(async () => undefined);
    const { service, setGoals } = setup({
      loadWorkLog: async () => {
        throw new Error("壊れています");
      },
      appendWorkLog,
    });
    setGoals(contestGoals);
    failures.length = 0;
    const found = await service.afterSave(workA, { wrote: true, written: 600 });
    expect(found.map((entry) => entry.kind)).toEqual(["daily"]);
    expect(appendWorkLog).not.toHaveBeenCalled();
    expect(failures.length).toBeGreaterThan(0);
  });

  test("書き込みに失敗した達成は祝わない（次の保存でもう一度確かめる）", async () => {
    const { service, setGoals } = setup({
      appendWorkLog: async () => {
        throw new Error("書けません");
      },
    });
    setGoals(contestGoals);
    const found = await service.afterSave(workA, { wrote: true, written: 600 });
    expect(found.map((entry) => entry.kind)).toEqual(["daily"]);
  });
});

describe("執筆統計で見せるのは一度だけ", () => {
  test("見せる前はまだ残り、見せたら消える", async () => {
    const { service } = setup();
    await service.afterSave(workA, { wrote: true, written: 600 });
    const pending = await service.pendingFor(workA);
    expect(pending?.size).toBe("small");
    expect(pending?.ids.length).toBe(1);
    expect(pending?.lines[0]).toContain("1日の目標");

    await service.markShown(pending!.ids);
    expect(await service.pendingFor(workA)).toBeUndefined();
  });

  test("ほかの作品の統計では、その作品の達成を上げない", async () => {
    const { service, setGoals } = setup();
    setGoals({
      schemaVersion: "0.1",
      perEpisodeChars: null,
      contest: {
        name: "テスト大賞",
        url: null,
        deadline: "2026-09-30",
        minChars: 600,
        maxChars: null,
        dailyGoal: null,
      },
    });
    await service.afterSave(workA, { wrote: true, written: 600 });
    const forB = await service.pendingFor(workB);
    // 1日の目標は共有なので出る。作品Aの達成は出ない
    expect(forB?.size).toBe("small");
    const forA = await service.pendingFor(workA);
    expect(forA?.size).toBe("fireworks");
  });

  test("下の欄の一言は、その日の間だけ", async () => {
    const { service } = setup();
    await service.afterSave(workA, { wrote: true, written: 600 });
    expect(await service.cheerFor(workA)).toBe("今日の目標に届きました");
  });
});
