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

/**
 * 連続達成（作者の裁定、2026-09-23）。日を進めながら保存し、
 * 連続・節目・最長が係を通しても正しく数えられるかを見る。
 */
describe("連続達成", () => {
  function daily(overrides: Partial<CelebrationDeps> = {}) {
    let today = "2026-09-01";
    const net = { value: 1_200 };
    const store = memento();
    const settings = { enabled: true, dailyGoal: 1_000, monthlyGoal: 0, boundaryHour: 4 };
    const loadStats = vi.fn(async () => [
      {
        schemaVersion: "0.1",
        deviceId: "pc1",
        baseline: null,
        days: [{ date: today, net: net.value, gross: net.value, saves: 1 }],
      } as unknown as DeviceWritingStats,
    ]);
    const service = new CelebrationService({
      memento: store,
      works: () => [workA],
      loadStats,
      loadWorkLog: async () => [],
      appendWorkLog: async () => undefined,
      readGoals: async () => ({ schemaVersion: "0.1", perEpisodeChars: null, contest: null }),
      settings: () => settings,
      now: () => new Date(`${today}T10:00:00`),
      ...overrides,
    });
    return {
      service,
      store,
      settings,
      loadStats,
      net,
      setDay: (day: string) => {
        today = day;
      },
      /** その日に届くまで書いて保存する */
      async reach(day: string) {
        today = day;
        return service.afterSave(workA, { wrote: true, written: net.value });
      },
    };
  }

  test("3日続けて届くと、札と下の欄に連続が出て、風船が増える", async () => {
    const { service, reach } = daily();
    await reach("2026-09-01");
    await reach("2026-09-02");
    const third = await reach("2026-09-03");
    expect(third[0].streak).toBe(3);

    const pending = await service.pendingFor(workA);
    expect(pending?.size).toBe("small");
    expect(pending?.balloons).toBe(7);
    expect(pending?.lines).toEqual(["1日の目標（1,000字）を3日連続で達成"]);
    expect(await service.cheerFor(workA)).toBe("3日連続で目標に届きました");
  });

  test("7日目は花火", async () => {
    const { service, reach } = daily();
    for (let day = 1; day <= 7; day++) {
      await reach(`2026-09-0${day}`);
    }
    const pending = await service.pendingFor(workA);
    expect(pending?.size).toBe("fireworks");
    expect(pending?.balloons).toBe(11);
  });

  test("途切れたら何も言わず、次に届いた日から数え直す", async () => {
    const { service, reach } = daily();
    await reach("2026-09-01");
    await reach("2026-09-02");
    const after = await reach("2026-09-04");
    expect(after[0].streak).toBeUndefined();
    const pending = await service.pendingFor(workA);
    expect(pending?.lines).toEqual(["1日の目標（1,000字）を達成"]);
    expect(pending?.balloons).toBe(5);
    expect(await service.cheerFor(workA)).toBe("今日の目標に届きました");
    // 最長は残る
    expect(service.streakSummary()).toEqual({ dailyBest: 2 });
  });

  test("同じ日に何度保存しても、連続は1日分しか進まない", async () => {
    const { service, reach, net } = daily();
    await reach("2026-09-01");
    net.value = 1_500;
    await reach("2026-09-01");
    await reach("2026-09-01");
    const next = await reach("2026-09-02");
    expect(next[0].streak).toBe(2);
    expect(service.streakSummary()).toEqual({ dailyBest: 2 });
  });

  test("同じ日に目標を上げて届き直しても、連続は増えず花火も繰り返さない", async () => {
    const { reach, settings, net } = daily();
    for (let day = 1; day <= 7; day++) await reach(`2026-09-0${day}`);
    settings.dailyGoal = 1_100;
    net.value = 1_200;
    const again = await reach("2026-09-07");
    expect(again[0].goal).toBe(1_100);
    expect(again[0].streak).toBe(7);
    expect(again[0].streakMilestone).toBeUndefined();
  });

  test("目標の値が日ごとに変わっても、その日の目標に届けば連続", async () => {
    const { reach, settings } = daily();
    await reach("2026-09-01");
    settings.dailyGoal = 800;
    const second = await reach("2026-09-02");
    expect(second[0].streak).toBe(2);
  });

  test("0.78.2以前の記録しか無いとき（帳面が無い）は、記録から組み直して続ける", async () => {
    const { store, reach } = daily();
    await store.update(
      "novelai.celebrations.global",
      [1, 2, 3, 4, 5, 6].map((day) => ({
        id: `daily:2026-09-0${day}:1000`,
        kind: "daily",
        day: `2026-09-0${day}`,
        at: `2026-09-0${day}T01:00:00.000Z`,
        goal: 1000,
        written: 1200,
      }))
    );
    const seventh = await reach("2026-09-07");
    expect(seventh[0]).toMatchObject({ streak: 7, streakMilestone: true });
  });

  test("連続を数えるのに、達成の記録を毎回組み直さない（帳面から進める）", async () => {
    const { store, reach } = daily();
    await reach("2026-09-01");
    await reach("2026-09-02");
    // 記録から古い行が落ちても（上限400件）、帳面が覚えている
    await store.update("novelai.celebrations.global", []);
    const third = await reach("2026-09-03");
    expect(third[0].streak).toBe(3);
  });

  test("最長を超えた日に花火（途切れたあとの連続が前の最長を追い抜いた日）", async () => {
    const { service, reach } = daily();
    for (const day of ["2026-09-01", "2026-09-02", "2026-09-03"]) await reach(day);
    for (const day of ["2026-09-10", "2026-09-11", "2026-09-12"]) {
      await reach(day);
    }
    const passed = await reach("2026-09-13");
    expect(passed[0]).toMatchObject({ streak: 4, streakRecord: true });
    const pending = await service.pendingFor(workA);
    expect(pending?.size).toBe("fireworks");
    expect(pending?.lines[0]).toBe(
      "1日の目標（1,000字）を4日連続で達成（これまでの最長を更新）"
    );
    expect(service.streakSummary()).toEqual({ dailyBest: 4 });
  });

  test("1か月の目標も月をまたいで連続を数える（年をまたいでも）", async () => {
    const { reach, settings } = daily();
    settings.dailyGoal = 0;
    settings.monthlyGoal = 1_000;
    await reach("2026-11-20");
    await reach("2026-12-15");
    const third = await reach("2027-01-10");
    expect(third[0]).toMatchObject({ kind: "monthly", streak: 3, streakMilestone: true });
  });

  test("最長が1のうちは、最長の欄に何も出さない", async () => {
    const { service, reach } = daily();
    expect(service.streakSummary()).toEqual({});
    await reach("2026-09-01");
    expect(service.streakSummary()).toEqual({});
  });
});
