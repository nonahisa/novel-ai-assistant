/**
 * 日本の祝日（設計書6.111.12）。
 *
 * 一覧は2つの出どころを持つ：
 *
 * 1. **同梱**（`holidaysJpData.ts`）。配布のたびに取り直す（`npm run holidays`）
 * 2. **作者が「祝日を取り込む」を押して取ったもの**。拡張機能の保管庫に控える
 *
 * **取得日の新しいほうを正にする**（`mergeHolidaySets`）。祝日は法の改正で動く
 * ことがある（2020年のオリンピックの移動など）ので、新しいほうが含む年は新しいほうだけを
 * 使い、新しいほうに無い年だけ古いほうから足す。
 *
 * VS Code API には依存しない（MCP の束からも読める）。
 */

import { isDateKey } from "../models/workGoals";

/** 出どころ（holidays-jp。Google カレンダーの日本の祝日が元） */
export const HOLIDAYS_URL = "https://holidays-jp.github.io/api/v1/date.json";
export const HOLIDAYS_LABEL = "holidays-jp（Google カレンダーの日本の祝日）";

export interface HolidaySet {
  /** どこから取ったか */
  readonly source: string;
  /** 取った日（`YYYY-MM-DD`） */
  readonly fetchedAt: string;
  /** 日付 → 祝日名 */
  readonly dates: Readonly<Record<string, string>>;
}

/** 空の一覧（読めなかったとき） */
export const NO_HOLIDAYS: HolidaySet = { source: "", fetchedAt: "", dates: {} };

/** 取得からこれより古ければ「古い」（配布の前段が知らせる） */
export const HOLIDAYS_STALE_DAYS = 182;

/**
 * API の返事（`{"2026-01-01": "元日", …}`）を確かめる。**形が違えば例外**
 * （壊れた一覧で休む日を決めない）。
 */
export function parseHolidayApi(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("祝日の一覧が、日付と名前の組になっていません。");
  }
  const dates: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDateKey(key) || typeof value !== "string" || !value.trim()) {
      throw new Error(`祝日の一覧に読めない行があります（${key}）。`);
    }
    dates[key] = value.trim();
  }
  if (Object.keys(dates).length === 0) throw new Error("祝日の一覧が空です。");
  return sortDates(dates);
}

/** 保管庫の控え（`HolidaySet` の形の JSON）を読む。読めなければ null（止めない） */
export function parseStoredHolidaySet(raw: unknown): HolidaySet | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.fetchedAt !== "string" || !isDateKey(value.fetchedAt)) return null;
  try {
    return {
      source: typeof value.source === "string" ? value.source : HOLIDAYS_URL,
      fetchedAt: value.fetchedAt,
      dates: parseHolidayApi(value.dates),
    };
  } catch {
    return null;
  }
}

/**
 * 2つの一覧を合わせる。**取得日の新しいほうが含む年は、新しいほうだけ**を使い、
 * 新しいほうに無い年だけ古いほうから足す（祝日の移動を古い一覧が打ち消さないように）。
 * 取得日が同じなら `a` を新しいほうとする。
 */
export function mergeHolidaySets(a: HolidaySet, b: HolidaySet | null): HolidaySet {
  if (!b) return a;
  const [newer, older] = b.fetchedAt > a.fetchedAt ? [b, a] : [a, b];
  const covered = new Set(Object.keys(newer.dates).map((date) => date.slice(0, 4)));
  const dates: Record<string, string> = { ...newer.dates };
  for (const [date, name] of Object.entries(older.dates)) {
    if (!covered.has(date.slice(0, 4))) dates[date] = name;
  }
  return { source: newer.source, fetchedAt: newer.fetchedAt, dates: sortDates(dates) };
}

export interface HolidayFreshness {
  /** 来年の祝日が入っているか */
  readonly coversNextYear: boolean;
  /** 取得から何日たったか */
  readonly ageDays: number;
  /** 取り直したほうがよいか（来年が無い・半年を超えた） */
  readonly stale: boolean;
  /** 含む年（小さい順） */
  readonly years: readonly number[];
}

export function holidayFreshness(set: HolidaySet, today: string): HolidayFreshness {
  const years = [...new Set(Object.keys(set.dates).map((date) => Number(date.slice(0, 4))))].sort(
    (x, y) => x - y
  );
  const coversNextYear = years.includes(Number(today.slice(0, 4)) + 1);
  const ageDays = set.fetchedAt
    ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${set.fetchedAt}T00:00:00Z`)) / 86_400_000)
    : Number.POSITIVE_INFINITY;
  return { coversNextYear, ageDays, stale: !coversNextYear || ageDays > HOLIDAYS_STALE_DAYS, years };
}

function sortDates(dates: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(dates).sort()) sorted[key] = dates[key];
  return sorted;
}
