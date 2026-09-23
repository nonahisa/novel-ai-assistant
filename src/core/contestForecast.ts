import type { DailyStat } from "../models/writingStats";
import { addDays } from "./writingStats";
import { upcomingDeadline } from "./contestDeadline";
import type { StoredContest } from "./contestInbox";

/**
 * 完成予定から公募を選び出す（設計書6.3.6.3）。
 *
 * 作者の依頼（2026-09-23）：巡航執筆速度と予定文字数から完成予定日を出し、
 * **締切に間に合い、かつ締切が完成予定に近い**公募を選び出す。
 *
 * ## 決め事
 *
 * | 何を | どう決めたか |
 * |---|---|
 * | 巡航速度 | **直近30日の平均**（作者の裁定）。今日を含む30日の純字数の合計を、書かなかった日も含めて30で割る |
 * | どの記録で | その作品で書いた日が5日以上あればその作品の記録。少なければ全作品の記録（どちらを使ったかは画面に出す） |
 * | 完成予定日 | 今日＋（予定−今の字数）÷巡航速度。日数は切り上げ |
 * | 速度が0 | **割らない**（日付を作らない）。呼ぶ側が作者に1日の字数を訊く |
 * | 10年を超える | 日付にしない（`tooSlow`）。遠すぎる日付は選ぶ材料にならない |
 * | 余裕 | 締切が完成予定日から7日以上あとのもの。見直し・推敲と、速度の揺れのぶん |
 * | 字数 | 予定が上限を超える・下限に届かない・いまの字数が上限を超えているものは外す。読めないものは外さず印を付ける |
 *
 * VS Code API には依存しない。
 */

/** 巡航速度を測る日数（作者の裁定：直近30日） */
export const PACE_WINDOW_DAYS = 30;
/** その作品の記録で測るのに要る「書いた日」の数。これ未満なら全作品の記録で測る */
export const MIN_WORK_ACTIVE_DAYS = 5;
/** 締切までに見ておく余裕の日数の既定 */
export const DEFAULT_SLACK_DAYS = 7;
/** これより先の完成予定は日付にしない */
export const MAX_FORECAST_DAYS = 3650;

export interface PaceWindow {
  /** 1日あたりの字数（小数のまま。画面では丸める） */
  readonly perDay: number;
  /** 窓の中の純字数の合計 */
  readonly windowChars: number;
  /** 窓の中で書いた（純字数が増えた）日の数 */
  readonly activeDays: number;
  readonly from: string;
  readonly to: string;
}

export interface CruisingPace extends PaceWindow {
  /** その作品の記録か、全作品の記録か */
  readonly basis: "work" | "allWorks";
}

/**
 * 直近の日数の平均。**書かなかった日も分母に入れる**——書いた日だけで割ると、
 * 週に1日しか書かない作者の速度が7倍に見え、完成予定が早すぎる日付になる。
 * 消した日（負の日）も差し引く。合計が0以下なら0。
 */
export function paceOver(
  days: readonly DailyStat[],
  today: string,
  windowDays: number = PACE_WINDOW_DAYS
): PaceWindow {
  const from = addDays(today, -(windowDays - 1));
  let windowChars = 0;
  let activeDays = 0;
  for (const entry of days) {
    if (entry.date < from || entry.date > today) continue;
    windowChars += entry.net;
    if (entry.net > 0) activeDays++;
  }
  return {
    perDay: windowChars > 0 ? windowChars / windowDays : 0,
    windowChars,
    activeDays,
    from,
    to: today,
  };
}

/**
 * どちらの記録で巡航速度を測るか決める。
 *
 * 作品を書き始めたばかりで記録が数日しか無いと、その数日の勢い（または
 * ほとんど書いていないこと）がそのまま完成予定になる。**書いた日が5日に
 * 満たなければ、作者自身の書く速さ（全作品の記録）で測る。**
 */
export function chooseCruisingPace(
  workDays: readonly DailyStat[],
  allDays: readonly DailyStat[],
  today: string
): CruisingPace {
  const work = paceOver(workDays, today);
  if (work.activeDays >= MIN_WORK_ACTIVE_DAYS) return { ...work, basis: "work" };
  return { ...paceOver(allDays, today), basis: "allWorks" };
}

export type CompletionForecast =
  /** もう予定の字数に届いている */
  | { readonly kind: "reached"; readonly date: string; readonly days: 0; readonly remaining: 0 }
  | { readonly kind: "dated"; readonly date: string; readonly days: number; readonly remaining: number }
  /** 速度が0（または数でない）。割らない */
  | { readonly kind: "noPace"; readonly remaining: number }
  /** 10年を超える見込み */
  | { readonly kind: "tooSlow"; readonly days: number; readonly remaining: number };

export function forecastCompletion(input: {
  target: number;
  written: number;
  perDay: number;
  today: string;
}): CompletionForecast {
  const remaining = Math.max(0, input.target - input.written);
  if (remaining === 0) return { kind: "reached", date: input.today, days: 0, remaining: 0 };
  if (!Number.isFinite(input.perDay) || input.perDay <= 0) return { kind: "noPace", remaining };
  const days = Math.ceil(remaining / input.perDay);
  if (days > MAX_FORECAST_DAYS) return { kind: "tooSlow", days, remaining };
  return { kind: "dated", date: addDays(input.today, days), days, remaining };
}

export interface ForecastCandidate {
  readonly contest: StoredContest;
  /** これからの締切 */
  readonly deadline: string;
  /** 完成予定日から締切までの日数（画面の「締切まで余裕○日」） */
  readonly slackDays: number;
  /** 字数が作品に合うか。読めなかったものは外さずに印す */
  readonly chars: "fits" | "unknownChars";
}

export interface ForecastSelection {
  readonly candidates: readonly ForecastCandidate[];
  /** 外したものの数（画面で「外したもの」を言う） */
  readonly excluded: {
    readonly tooSoon: number;
    readonly charMismatch: number;
    readonly noDeadline: number;
    readonly past: number;
  };
}

/**
 * 締切≧完成予定日＋余裕 の公募を、**字数の合うものを先に、その中は締切の近い順**に並べる。
 *
 * 締切の近い順にするのは、「間に合う中でいちばん早く出せるもの」が
 * 完成予定に近い締切だから（作者の依頼：「締切が完成予定に近い公募を」）。
 */
export function selectContestsForForecast(
  inbox: readonly StoredContest[],
  options: {
    finishDate: string;
    today: string;
    written: number;
    target: number;
    slackDays?: number;
  }
): ForecastSelection {
  const slack = options.slackDays ?? DEFAULT_SLACK_DAYS;
  const candidates: ForecastCandidate[] = [];
  let tooSoon = 0;
  let charMismatch = 0;
  let noDeadline = 0;
  let past = 0;
  for (const contest of inbox) {
    if (contest.deadlines.length === 0) {
      noDeadline++;
      continue;
    }
    const deadline = upcomingDeadline(contest.deadlines, options.today);
    if (deadline === null) {
      past++;
      continue;
    }
    const chars = charFit(contest, options.written, options.target);
    if (chars === "mismatch") {
      charMismatch++;
      continue;
    }
    const slackDays = dayDiff(options.finishDate, deadline);
    if (slackDays < slack) {
      tooSoon++;
      continue;
    }
    candidates.push({ contest, deadline, slackDays, chars });
  }
  candidates.sort(
    (a, b) =>
      (a.chars === "fits" ? 0 : 1) - (b.chars === "fits" ? 0 : 1) ||
      a.deadline.localeCompare(b.deadline) ||
      a.contest.name.localeCompare(b.contest.name, "ja")
  );
  return { candidates, excluded: { tooSoon, charMismatch, noDeadline, past } };
}

function charFit(
  contest: StoredContest,
  written: number,
  target: number
): "fits" | "unknownChars" | "mismatch" {
  const limit = contest.charLimit;
  if (limit.kind === "none") return "fits";
  if (limit.kind === "unreadable") return "unknownChars";
  if (limit.max !== null && (written > limit.max || target > limit.max)) return "mismatch";
  if (limit.min !== null && target < limit.min) return "mismatch";
  return "fits";
}

/** b − a の日数（YYYY-MM-DD どうし） */
function dayDiff(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000
  );
}
