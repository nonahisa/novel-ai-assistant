import { addDays } from "./writingStats";
import { PACE_WINDOW_DAYS } from "./contestForecast";
import { NO_HOLIDAYS, type HolidaySet } from "./holidays";

/**
 * 作業の暦（設計書6.111.12）——**日の種類ごとの作業量の割合**。
 *
 * 作者の依頼（2026-09-23）：「曜日と祝日を選べる」「副業の場合は祝日のほうが動けるかも」。
 * 休むか作業するかの二択ではなく、平日・土日・祝日のそれぞれに割合を持つ
 * （0 は休み）。曜日ごとの上書きもできる（「水曜は 0」）。**既定は全部 1**
 * ——いまの逆算（毎日同じだけ進む）を変えない。
 *
 * ## 日の種類の決め方（上から先に当たったもの）
 *
 * 1. **祝日**（振替休日を含む）。**土日と重なっても祝日**として扱う
 *    ——勤めのある人にとってはどちらも休みで、祝日の割合を別に決めた人
 *    （祝日は家の用事で書けない、など）の決めごとを優先するため
 * 2. **曜日ごとの上書き**（決めてある曜日だけ）
 * 3. 土日なら**土日**、ほかは**平日**
 *
 * 祝日を曜日の上書きより先にしたのは、曜日の上書きが「毎週の決まった用事」を
 * 表すことが多く、祝日にはその用事ごと休みになることが多いため。
 *
 * ## 巡航速度との釣り合い（割り戻し）
 *
 * 巡航速度（直近30日の1日あたりの字数、6.3.6.3）には、平日と休日の書き方が
 * **もう混ざっている**。割合をそのまま掛けると、その混ざりをもう一度数えて
 * 見積もりが速すぎる（または遅すぎる）ことになる。そこで、**巡航速度を測った
 * 30日の並び（曜日・祝日）で割合の平均 m を出し、各日の割合を m で割る**
 * （`dayCapacity = 割合 ÷ m`）。こうすると、その30日に同じ割合を当てはめた
 * 合計は、巡航速度 × 30 と一致する——見積もりは速くも遅くもならない。
 *
 * 決まった日数の段（推敲7日など）も同じ m で割る。割合は**相対の値**なので、
 * 「平日1・土日3」と「平日0.5・土日1.5」は同じ見積もりになる。
 *
 * VS Code API には依存しない。
 */

export interface WorkloadSettings {
  /** 平日の割合（0 は休み） */
  readonly weekday: number;
  /** 土日の割合 */
  readonly weekend: number;
  /** 祝日の割合（土日と重なっても祝日） */
  readonly holiday: number;
  /** 曜日ごとの上書き（0=日〜6=土）。null はその曜日の種類どおり */
  readonly byWeekday: readonly (number | null)[];
  /**
   * 作者が手を動かす段が重なったときに、重なり1つごとに落ちる割合（0〜0.9。既定 0.1）。
   * 切り替えの損（設計書6.111.14）
   */
  readonly overlapPenalty: number;
}

/** 割合の上限。これより大きい値は打ち間違いとみなす */
export const MAX_WORKLOAD_WEIGHT = 10;
export const MAX_OVERLAP_PENALTY = 0.9;
export const DEFAULT_OVERLAP_PENALTY = 0.1;

export const DEFAULT_WORKLOAD: WorkloadSettings = {
  weekday: 1,
  weekend: 1,
  holiday: 1,
  byWeekday: [null, null, null, null, null, null, null],
  overlapPenalty: DEFAULT_OVERLAP_PENALTY,
};

/** 設定の曜日の鍵（`novelai.schedule.weekdayOverrides`）。0=日〜6=土 の順 */
export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export interface RawWorkloadSettings {
  readonly weekday?: unknown;
  readonly weekend?: unknown;
  readonly holiday?: unknown;
  /** `{ "wed": 0 }` の形 */
  readonly weekdayOverrides?: unknown;
  readonly overlapPenalty?: unknown;
}

/**
 * 設定の値を確かめる。**読めない値は既定に戻し、戻したことを返す**（黙って使わない）。
 * 割合がすべて0（どの日も作業しない）なら、逆算ができないので既定に戻す。
 */
export function normalizeWorkload(raw: RawWorkloadSettings): {
  settings: WorkloadSettings;
  problems: string[];
} {
  const problems: string[] = [];
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_WORKLOAD_WEIGHT;
  const weight = (value: unknown, label: string, fallback: number): number => {
    if (value === undefined || value === null) return fallback;
    if (!valid(value)) {
      problems.push(`${label}の割合（${String(value)}）は0〜${MAX_WORKLOAD_WEIGHT}の数にしてください。${fallback}として数えています`);
      return fallback;
    }
    return value;
  };
  const weekday = weight(raw.weekday, "平日", 1);
  const weekend = weight(raw.weekend, "土日", 1);
  const holiday = weight(raw.holiday, "祝日", 1);
  const byWeekday: (number | null)[] = [null, null, null, null, null, null, null];
  if (raw.weekdayOverrides !== undefined && raw.weekdayOverrides !== null) {
    if (typeof raw.weekdayOverrides !== "object" || Array.isArray(raw.weekdayOverrides)) {
      problems.push("曜日ごとの割合は { \"wed\": 0 } の形にしてください。使わずに数えています");
    } else {
      const map = raw.weekdayOverrides as Record<string, unknown>;
      for (const [key, value] of Object.entries(map)) {
        const index = WEEKDAY_KEYS.indexOf(key as (typeof WEEKDAY_KEYS)[number]);
        if (index < 0) {
          problems.push(`曜日ごとの割合の「${key}」は知らない曜日です（sun〜sat）。使わずに数えています`);
          continue;
        }
        if (value === null || value === undefined) continue;
        if (!valid(value)) {
          problems.push(
            `${WEEKDAY_LABELS[index]}曜の割合（${String(value)}）は0〜${MAX_WORKLOAD_WEIGHT}の数にしてください。使わずに数えています`
          );
          continue;
        }
        byWeekday[index] = value;
      }
    }
  }
  let overlapPenalty = DEFAULT_OVERLAP_PENALTY;
  if (raw.overlapPenalty !== undefined && raw.overlapPenalty !== null) {
    const value = raw.overlapPenalty;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_OVERLAP_PENALTY) {
      problems.push(`重なりの損（${String(value)}）は0〜${MAX_OVERLAP_PENALTY}の数にしてください。${DEFAULT_OVERLAP_PENALTY}として数えています`);
    } else {
      overlapPenalty = value;
    }
  }
  const settings: WorkloadSettings = { weekday, weekend, holiday, byWeekday, overlapPenalty };
  const anyWork =
    [0, 1, 2, 3, 4, 5, 6].some((day) => weekTypeWeight(settings, day) > 0) || holiday > 0;
  if (!anyWork) {
    problems.push("作業量の割合がすべて0なので、毎日1として数えています");
    return { settings: { ...DEFAULT_WORKLOAD, overlapPenalty }, problems };
  }
  return { settings, problems };
}

/** 祝日でない日の割合（曜日の上書き → 土日／平日） */
function weekTypeWeight(settings: WorkloadSettings, weekday: number): number {
  const override = settings.byWeekday[weekday];
  if (override !== null && override !== undefined) return override;
  return weekday === 0 || weekday === 6 ? settings.weekend : settings.weekday;
}

/** 0=日〜6=土 */
function weekdayOfKey(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** その日の割合（割り戻す前） */
export function dayWeight(dateKey: string, settings: WorkloadSettings, holidays: HolidaySet): number {
  if (holidays.dates[dateKey] !== undefined) return settings.holiday;
  return weekTypeWeight(settings, weekdayOfKey(dateKey));
}

export interface WorkCalendar {
  readonly settings: WorkloadSettings;
  readonly holidays: HolidaySet;
  /** 割り戻しに使う割合の平均（巡航速度を測った30日の並びで） */
  readonly meanWeight: number;
  /** 割り戻しの30日（巡航速度の窓と同じ） */
  readonly from: string;
  readonly to: string;
  /** すべての割合が1か（いまの逆算と同じ。速い道を通す） */
  readonly uniform: boolean;
}

/**
 * 作業の暦を作る。割り戻しの平均は、巡航速度の窓（今日を含む直近30日）で出す。
 * その30日の割合がすべて0（祝日だけ作業する設定で、30日に祝日が無いなど）なら、
 * 直近1年で出し直す。それでも0なら割り戻さない（1で割る）。
 */
export function buildWorkCalendar(
  settings: WorkloadSettings,
  holidays: HolidaySet,
  today: string
): WorkCalendar {
  const uniform =
    settings.weekday === 1 &&
    settings.weekend === 1 &&
    settings.holiday === 1 &&
    settings.byWeekday.every((value) => value === null || value === 1);
  const from = addDays(today, -(PACE_WINDOW_DAYS - 1));
  let mean = uniform ? 1 : meanWeightOver(from, today, settings, holidays);
  if (!(mean > 0)) mean = meanWeightOver(addDays(today, -364), today, settings, holidays);
  if (!(mean > 0)) mean = 1;
  return { settings, holidays, meanWeight: mean, from, to: today, uniform };
}

export function meanWeightOver(
  from: string,
  to: string,
  settings: WorkloadSettings,
  holidays: HolidaySet
): number {
  let sum = 0;
  let count = 0;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    sum += dayWeight(date, settings, holidays);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/** 毎日同じだけ進む暦（既定・試験用） */
export function uniformCalendar(today = "2000-01-01"): WorkCalendar {
  return buildWorkCalendar(DEFAULT_WORKLOAD, NO_HOLIDAYS, today);
}

/**
 * その日に進む量（平均の日を1とした量）。割合 ÷ 割り戻しの平均。
 * 休み（割合0）の日は0。
 */
export function dayCapacity(calendar: WorkCalendar, dateKey: string): number {
  if (calendar.uniform) return 1;
  return dayWeight(dateKey, calendar.settings, calendar.holidays) / calendar.meanWeight;
}

export function holidayNameOf(calendar: WorkCalendar, dateKey: string): string | null {
  return calendar.holidays.dates[dateKey] ?? null;
}

/**
 * 重なったときの速さ（1つの作業あたり、ひとりで進めるときを1として）。
 *
 * **分け合う＋切り替えの損**（作者の裁定、2026-09-23）：1日の作業量を重なった数 k で
 * 分け合い、さらに重なり1つ増えるごとに損の割合 p だけ落ちる。落ち方は掛け算
 * （`(1 − p)^(k − 1)`）にした——引き算（`1 − p(k − 1)`）だと重なりが11を超えたところで
 * 速さが0や負になり、逆算が終わらなくなるため。k が2〜3なら両者の差は1%未満。
 *
 *   速さ(k) = (1 − p)^(k − 1) ÷ k
 */
export function sharedSpeed(k: number, penalty: number): number {
  if (k <= 1) return 1;
  return Math.pow(1 - penalty, k - 1) / k;
}
