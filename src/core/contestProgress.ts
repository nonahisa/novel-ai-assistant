import type { ContestGoal, WorkGoals } from "../models/workGoals";

/**
 * 締切に対する進み具合（設計書6.3.6）。
 *
 * **急かすための機能ではない。** 「間に合うのか」「今日どれだけ書けばよいか」に
 * 数字で答えるためのものである。だから、
 *
 * - **必要な日割りは、書いた分を差し引いてから割る。** 目標総字数を
 *   締切までの日数で割るだけだと、書いても数字が減らない
 * - **締切当日も1日として数える。** 「残り0日」では今日書けないことになる
 * - **間に合わない見込みでも、そう言うだけで止めない。** 目標を下げるか
 *   書く量を増やすかは作者が決める
 *
 * VS Code APIに依存しない。
 */

export interface ContestProgress {
  contest: ContestGoal;
  /** いまの総字数 */
  written: number;
  /** 目標の字数。下限があればそれ、無ければ上限 */
  targetChars: number | null;
  /** 目標までの残り。目標が無ければ null。**負にはしない** */
  remainingChars: number | null;
  /** 締切までの日数。当日は1、過ぎていれば0 */
  daysLeft: number;
  /** 締切を過ぎているか */
  overdue: boolean;
  /**
   * 今日から1日あたり必要な字数。
   * 作者が日間目標を決めていればそちら。目標が無ければ null
   */
  neededPerDay: number | null;
  /** 作者が決めた日間目標（決めていなければ null） */
  authorDailyGoal: number | null;
  /** 上限を超えているか。応募規定を外れるので知らせる必要がある */
  overMax: boolean;
}

/**
 * 目標にする字数を決める。
 *
 * **下限を優先する。** 「10万字以上」の応募では、まず届くことが目標になる。
 * 上限しか無ければ上限を目標にする（「8,000字以内」なら8,000字書ける）。
 */
export function targetCharsOf(contest: ContestGoal): number | null {
  return contest.minChars ?? contest.maxChars ?? null;
}

/**
 * 締切までの日数。**当日を1日として数える。**
 *
 * 日付だけで比べる（時刻を持たない）。締切が「今日」なら、
 * 今日いっぱい書けるので1日である。
 */
export function daysUntil(deadline: string, todayKey: string): number {
  const days = Math.round(
    (Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) /
      86_400_000
  );
  return days >= 0 ? days + 1 : 0;
}

export function buildContestProgress(
  goals: WorkGoals,
  written: number,
  todayKey: string
): ContestProgress | undefined {
  const contest = goals.contest;
  if (!contest) return undefined;

  const targetChars = targetCharsOf(contest);
  const remainingChars =
    targetChars === null ? null : Math.max(0, targetChars - written);
  const daysLeft = daysUntil(contest.deadline, todayKey);

  return {
    contest,
    written,
    targetChars,
    remainingChars,
    daysLeft,
    overdue: daysLeft === 0,
    neededPerDay: neededPerDay(contest, remainingChars, daysLeft),
    authorDailyGoal: contest.dailyGoal,
    overMax: contest.maxChars !== null && written > contest.maxChars,
  };
}

/**
 * 1日あたり必要な字数。
 *
 * 作者が決めた日間目標があればそれを返す。割り算では出ない事情
 * （平日は書けない、など）を、こちらの計算で上書きしない。
 */
function neededPerDay(
  contest: ContestGoal,
  remainingChars: number | null,
  daysLeft: number
): number | null {
  if (contest.dailyGoal !== null) return contest.dailyGoal;
  if (remainingChars === null) return null;
  // 締切を過ぎていれば「1日あたり」は意味を持たない。
  // 残り全部を出しても、それは日割りではない
  if (daysLeft === 0) return null;
  return Math.ceil(remainingChars / daysLeft);
}

/**
 * 作者に見せる一言。
 *
 * **数字だけでは判断できない。** 「残り12,000字／3日」を見て
 * 間に合うかどうかを毎回暗算させない。
 */
export function describeContestProgress(progress: ContestProgress): string {
  const { contest, written, targetChars, remainingChars, daysLeft } = progress;
  const chars = (value: number) => value.toLocaleString("ja-JP");

  if (progress.overMax) {
    return (
      `${contest.name}：上限 ${chars(contest.maxChars!)}字を ` +
      `${chars(written - contest.maxChars!)}字 超えています。削る必要があります。`
    );
  }
  if (progress.overdue) {
    return `${contest.name}：締切（${contest.deadline}）を過ぎています。`;
  }
  if (targetChars === null) {
    return `${contest.name}：締切まであと${daysLeft}日です（現在 ${chars(written)}字）。`;
  }
  if (remainingChars === 0) {
    return (
      `${contest.name}：目標の ${chars(targetChars)}字に届いています` +
      `（現在 ${chars(written)}字）。締切まであと${daysLeft}日。`
    );
  }
  return (
    `${contest.name}：締切まであと${daysLeft}日、残り ${chars(remainingChars!)}字。` +
    `1日あたり ${chars(progress.neededPerDay!)}字です。`
  );
}
