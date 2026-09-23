import { describe, expect, test } from "vitest";
import {
  buildWorkCalendar,
  dayCapacity,
  dayWeight,
  DEFAULT_WORKLOAD,
  normalizeWorkload,
  sharedSpeed,
  type WorkloadSettings,
} from "../../../src/core/workCalendar";
import { NO_HOLIDAYS, type HolidaySet } from "../../../src/core/holidays";
import { addDays } from "../../../src/core/writingStats";

/**
 * 作業の暦（設計書6.111.12）。日の種類の決め方、巡航速度との釣り合い（割り戻し）、
 * 重なりの速さの式を押さえる。
 */

const HOLIDAYS: HolidaySet = {
  source: "test",
  fetchedAt: "2026-09-01",
  dates: {
    "2026-09-21": "敬老の日", // 月曜
    "2026-09-22": "国民の休日", // 火曜
    "2026-09-23": "秋分の日", // 水曜
    "2026-11-03": "文化の日", // 火曜
    "2027-01-03": "テストの祝日", // 日曜（土日と重なる祝日）
  },
};

function settings(patch: Partial<WorkloadSettings>): WorkloadSettings {
  return { ...DEFAULT_WORKLOAD, ...patch };
}

describe("日の種類", () => {
  const side = settings({ weekday: 1, weekend: 3, holiday: 2, byWeekday: [null, null, null, 0, null, null, null] });

  test("平日・土日・曜日の上書き", () => {
    expect(dayWeight("2026-10-05", side, HOLIDAYS)).toBe(1); // 月
    expect(dayWeight("2026-10-03", side, HOLIDAYS)).toBe(3); // 土
    expect(dayWeight("2026-10-04", side, HOLIDAYS)).toBe(3); // 日
    expect(dayWeight("2026-10-07", side, HOLIDAYS)).toBe(0); // 水は0（上書き）
  });

  test("祝日は曜日の上書きより先（水曜の祝日は祝日の割合）", () => {
    expect(dayWeight("2026-09-23", side, HOLIDAYS)).toBe(2);
  });

  test("土日と重なる祝日は祝日として扱う", () => {
    expect(dayWeight("2027-01-03", side, HOLIDAYS)).toBe(2);
  });

  test("祝日の境目：前日・翌日は平日", () => {
    expect(dayWeight("2026-11-02", side, HOLIDAYS)).toBe(1);
    expect(dayWeight("2026-11-03", side, HOLIDAYS)).toBe(2);
    expect(dayWeight("2026-11-04", side, HOLIDAYS)).toBe(0); // 水曜の上書き
  });
});

describe("巡航速度との釣り合い（割り戻し）", () => {
  test("既定（全部1）は毎日1で、祝日があっても変わらない", () => {
    const calendar = buildWorkCalendar(DEFAULT_WORKLOAD, HOLIDAYS, "2026-09-30");
    expect(calendar.uniform).toBe(true);
    expect(dayCapacity(calendar, "2026-09-23")).toBe(1);
    expect(dayCapacity(calendar, "2026-10-03")).toBe(1);
  });

  test("巡航速度を測った30日の並びで割合をかけても、合計は30日ぶんのまま（速くも遅くもならない）", () => {
    const today = "2026-09-30";
    for (const pattern of [
      settings({ weekday: 1, weekend: 3, holiday: 3 }),
      settings({ weekday: 0.5, weekend: 2, holiday: 0 }),
      settings({ weekday: 1, weekend: 0, holiday: 0, byWeekday: [null, null, null, 0, null, null, null] }),
    ]) {
      const calendar = buildWorkCalendar(pattern, HOLIDAYS, today);
      let total = 0;
      for (let date = calendar.from; date <= calendar.to; date = addDays(date, 1)) {
        total += dayCapacity(calendar, date);
      }
      expect(total).toBeCloseTo(30, 9);
    }
  });

  test("割合は相対の値：平日1・土日3 と 平日0.5・土日1.5 は同じ進み", () => {
    const a = buildWorkCalendar(settings({ weekday: 1, weekend: 3, holiday: 3 }), HOLIDAYS, "2026-09-30");
    const b = buildWorkCalendar(settings({ weekday: 0.5, weekend: 1.5, holiday: 1.5 }), HOLIDAYS, "2026-09-30");
    for (const date of ["2026-10-05", "2026-10-03", "2026-09-23"]) {
      expect(dayCapacity(a, date)).toBeCloseTo(dayCapacity(b, date), 12);
    }
  });

  test("30日の割合がすべて0（祝日だけ作業し、30日に祝日が無い）なら1年で割り戻す", () => {
    const onlyHolidays = settings({ weekday: 0, weekend: 0, holiday: 1 });
    const calendar = buildWorkCalendar(onlyHolidays, HOLIDAYS, "2026-12-20");
    expect(calendar.meanWeight).toBeGreaterThan(0);
    expect(dayCapacity(calendar, "2026-12-21")).toBe(0);
  });
});

describe("設定の確かめ", () => {
  test("読めない値は既定に戻し、戻したことを返す", () => {
    const { settings: normalized, problems } = normalizeWorkload({
      weekday: -1,
      weekend: "3",
      holiday: 2,
      weekdayOverrides: { wed: 0, xyz: 1, fri: 99 },
      overlapPenalty: 2,
    });
    expect(normalized.weekday).toBe(1);
    expect(normalized.weekend).toBe(1);
    expect(normalized.holiday).toBe(2);
    expect(normalized.byWeekday).toEqual([null, null, null, 0, null, null, null]);
    expect(normalized.overlapPenalty).toBe(0.1);
    expect(problems.length).toBe(5);
  });

  test("割合がすべて0なら毎日1に戻す（逆算ができないため）", () => {
    const { settings: normalized, problems } = normalizeWorkload({ weekday: 0, weekend: 0, holiday: 0 });
    expect(normalized.weekday).toBe(1);
    expect(problems.join("")).toContain("すべて0");
  });

  test("何も決めていなければ既定のまま・断りなし", () => {
    expect(normalizeWorkload({})).toEqual({ settings: DEFAULT_WORKLOAD, problems: [] });
  });

  test("祝日が無い一覧でも作れる", () => {
    expect(buildWorkCalendar(settings({ weekend: 2 }), NO_HOLIDAYS, "2026-09-30").meanWeight).toBeGreaterThan(1);
  });
});

describe("重なりの速さ（分け合う＋切り替えの損）", () => {
  test("重なり0・1は1（ひとりで進める）", () => {
    expect(sharedSpeed(0, 0.1)).toBe(1);
    expect(sharedSpeed(1, 0.1)).toBe(1);
  });

  test("2つなら半分からさらに1割、3つなら3分の1から2回ぶん落ちる", () => {
    expect(sharedSpeed(2, 0.1)).toBeCloseTo(0.45, 12);
    expect(sharedSpeed(3, 0.1)).toBeCloseTo(0.81 / 3, 12);
  });

  test("損0なら分け合うだけ。重なりが多くても0や負にならない", () => {
    expect(sharedSpeed(4, 0)).toBeCloseTo(0.25, 12);
    expect(sharedSpeed(20, 0.9)).toBeGreaterThan(0);
  });
});
