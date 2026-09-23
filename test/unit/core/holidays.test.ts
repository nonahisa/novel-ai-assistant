import { describe, expect, test } from "vitest";
import {
  holidayFreshness,
  HOLIDAYS_STALE_DAYS,
  HOLIDAYS_URL,
  mergeHolidaySets,
  parseHolidayApi,
  parseStoredHolidaySet,
  type HolidaySet,
} from "../../../src/core/holidays";
import { BUNDLED_HOLIDAYS } from "../../../src/core/holidaysJpData";

/**
 * 祝日の一覧（設計書6.111.12）。API の形の確かめ、同梱と取り込んだものの合わせ方、
 * 同梱の一覧の鮮度。
 */

describe("API の返事を確かめる", () => {
  test("日付と名前の組なら通す（並びは日付の順にそろえる）", () => {
    expect(parseHolidayApi({ "2026-11-03": "文化の日", "2026-01-01": "元日" })).toEqual({
      "2026-01-01": "元日",
      "2026-11-03": "文化の日",
    });
  });

  test("形の違うものは止める（壊れた一覧で休む日を決めない）", () => {
    expect(() => parseHolidayApi([])).toThrow();
    expect(() => parseHolidayApi({ "2026/01/01": "元日" })).toThrow();
    expect(() => parseHolidayApi({ "2026-01-01": "" })).toThrow();
    expect(() => parseHolidayApi({})).toThrow();
  });

  test("保管庫の控えは、読めなければ null（止めない）", () => {
    expect(parseStoredHolidaySet({ fetchedAt: "2026-09-24", dates: { "2026-01-01": "元日" } })?.fetchedAt).toBe("2026-09-24");
    expect(parseStoredHolidaySet({ fetchedAt: "昨日", dates: {} })).toBeNull();
    expect(parseStoredHolidaySet("壊れている")).toBeNull();
  });
});

describe("同梱と取り込んだものを合わせる", () => {
  const older: HolidaySet = {
    source: HOLIDAYS_URL,
    fetchedAt: "2026-01-10",
    dates: { "2025-01-01": "元日", "2026-07-20": "海の日", "2027-01-01": "元日" },
  };
  const newer: HolidaySet = {
    source: HOLIDAYS_URL,
    fetchedAt: "2026-09-24",
    // 2026年の海の日が動いた（と仮に）。2028年が増えた
    dates: { "2026-07-23": "海の日", "2027-01-01": "元日", "2028-01-01": "元日" },
  };

  test("新しいほうが含む年は新しいほうだけ、無い年は古いほうから足す", () => {
    const merged = mergeHolidaySets(older, newer);
    expect(merged.fetchedAt).toBe("2026-09-24");
    expect(merged.dates).toEqual({
      "2025-01-01": "元日",
      "2026-07-23": "海の日",
      "2027-01-01": "元日",
      "2028-01-01": "元日",
    });
  });

  test("渡す順を入れ替えても同じ", () => {
    expect(mergeHolidaySets(newer, older)).toEqual(mergeHolidaySets(older, newer));
  });

  test("取り込んだものが無ければ同梱のまま", () => {
    expect(mergeHolidaySets(older, null)).toBe(older);
  });
});

describe("鮮度", () => {
  test("来年の分が無い・半年を超えたら古い", () => {
    const set: HolidaySet = { source: "", fetchedAt: "2026-01-01", dates: { "2026-01-01": "元日", "2027-01-01": "元日" } };
    expect(holidayFreshness(set, "2026-03-01").stale).toBe(false);
    expect(holidayFreshness(set, "2027-01-02").coversNextYear).toBe(false);
    expect(holidayFreshness(set, "2026-12-31").ageDays).toBeGreaterThan(HOLIDAYS_STALE_DAYS);
    expect(holidayFreshness(set, "2026-12-31").stale).toBe(true);
  });
});

describe("同梱の一覧", () => {
  test("形が正しい（API と同じ確かめを通る）", () => {
    expect(BUNDLED_HOLIDAYS.source).toBe(HOLIDAYS_URL);
    expect(parseHolidayApi(BUNDLED_HOLIDAYS.dates)).toEqual(BUNDLED_HOLIDAYS.dates);
    expect(Object.keys(BUNDLED_HOLIDAYS.dates).length).toBeGreaterThan(30);
  });

  /**
   * **落とさずに知らせる。** 同梱の一覧が古くても、逆算がずれるのは新しく決まった祝日の
   * 1日だけで、テストを落として作業を止めるほどではない。配布の前段
   * （`npm run package:vsix` の最初の `updateHolidays.mjs --check`）でも同じことを言う。
   */
  test("来年の分があり、取得から半年以内か（古ければ警告だけ出す）", () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const freshness = holidayFreshness(BUNDLED_HOLIDAYS, today);
    if (freshness.stale) {
      console.warn(
        `同梱の祝日の一覧が古くなっています（取得 ${BUNDLED_HOLIDAYS.fetchedAt}・来年の分${freshness.coversNextYear ? "あり" : "なし"}）。` +
          "npm run holidays で取り直してください。"
      );
    }
    expect(freshness.years.length).toBeGreaterThan(0);
  });
});
