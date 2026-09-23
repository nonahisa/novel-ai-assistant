import type { ScheduleFile } from "../models/schedule";
import { addDays } from "./writingStats";
import {
  planSchedule,
  schedulesWithGoals,
  serialCharsBy,
  type PlanContext,
  type PlannedSchedule,
} from "./schedulePlan";

/**
 * スケジュールの画面の中身（設計書6.111.7）。縦が時間、横が作品。
 *
 * **作業が発生している作品だけを並べる**（作者の指定、2026-09-23）。済んだ・
 * 過ぎた作品は「済んだ作品も見る」のときだけ。読めなかった作品は**いつも出す**
 * （隠すと、壊れていることに気づけない）。
 *
 * VS Code API には依存しない。
 */

export interface WorkScheduleInput {
  readonly workId: string;
  readonly title: string;
  /** 読めなかった・無いときは null（無いときは空のファイルとして渡す） */
  readonly file: ScheduleFile | null;
  /** 読めなかった理由。読めたら null */
  readonly error: string | null;
  readonly context: PlanContext;
}

export interface BoardPlan extends PlannedSchedule {
  /** 画面に出す注意（間に合わない・重なり・仮の日数・書き溜め） */
  readonly alerts: readonly string[];
}

export interface BoardColumn {
  readonly workId: string;
  readonly title: string;
  readonly plans: readonly BoardPlan[];
  readonly error: string | null;
  /** 作業が発生しているか */
  readonly active: boolean;
  /** 巡航速度（画面の見出しに添える） */
  readonly perDay: number;
}

export interface ScheduleBoard {
  readonly today: string;
  /** 縦の範囲（上端と下端） */
  readonly from: string;
  readonly to: string;
  readonly columns: readonly BoardColumn[];
  /** 隠した（済んだ・過ぎた）作品の数 */
  readonly hiddenCount: number;
}

/** 今日より上に見せる日数 */
export const BOARD_LEAD_DAYS = 14;
/** 最後の予定より下に見せる日数 */
export const BOARD_TAIL_DAYS = 14;
/** 今日から少なくともここまでは見せる */
export const BOARD_MIN_AHEAD_DAYS = 60;
/** 上へ広げる限度（遅れが10年を超えても、それ以上は描かない） */
const BOARD_MAX_BACK_DAYS = 3650;

export function buildScheduleBoard(
  works: readonly WorkScheduleInput[],
  options: { today: string; now: string; showFinished: boolean }
): ScheduleBoard {
  const today = options.today;
  const all: BoardColumn[] = works.map((work) => {
    if (work.file === null) {
      return {
        workId: work.workId,
        title: work.title,
        plans: [],
        error: work.error ?? "スケジュールを読めませんでした",
        active: true,
        perDay: work.context.perDay,
      };
    }
    const planned = schedulesWithGoals(work.file, work.context.goalsContest, options.now).map(
      ({ schedule, virtual }) => planSchedule(schedule, work.context, virtual)
    );
    const serials = planned.filter((plan) => plan.serial !== null);
    const plans: BoardPlan[] = planned.map((plan) => ({
      ...plan,
      alerts: alertsFor(plan, serials, work.context),
    }));
    return {
      workId: work.workId,
      title: work.title,
      plans,
      error: null,
      active: plans.some((plan) => plan.active),
      perDay: work.context.perDay,
    };
  });

  const columns = options.showFinished
    ? all.filter((column) => column.plans.length > 0 || column.error !== null)
    : all.filter((column) => column.active);
  const hiddenCount = all.filter(
    (column) => column.plans.length > 0 && !columns.includes(column)
  ).length;

  let from = addDays(today, -BOARD_LEAD_DAYS);
  let to = addDays(today, BOARD_MIN_AHEAD_DAYS);
  const floor = addDays(today, -BOARD_MAX_BACK_DAYS);
  for (const column of columns) {
    for (const plan of column.plans) {
      for (const date of datesOf(plan, options.showFinished)) {
        if (date < from) from = date < floor ? floor : date;
        if (date > to) to = date;
      }
    }
  }
  if (from < addDays(today, -BOARD_LEAD_DAYS)) from = addDays(from, -3);
  to = addDays(to, BOARD_TAIL_DAYS);

  return { today, from, to, columns, hiddenCount };
}

/** 縦の範囲を決めるのに使う日付。済んだ段は「済んだ作品も見る」のときだけ上へ広げる */
function datesOf(plan: PlannedSchedule, showFinished: boolean): string[] {
  const dates: string[] = [];
  if (plan.milestone) dates.push(plan.milestone);
  if (plan.earliestMilestone) dates.push(plan.earliestMilestone);
  for (const step of plan.steps) {
    if (step.step.status === "done" && !showFinished) continue;
    // 長さ0の段（字数に届いた執筆）は終わりだけ
    if (step.days > 0) dates.push(step.start);
    dates.push(step.end);
  }
  if (plan.serial) {
    for (const slot of plan.serial.slots) {
      if (slot.state === "posted" && !showFinished) continue;
      dates.push(slot.date);
    }
    for (const writing of plan.serial.writing) dates.push(writing.start, writing.end);
  }
  return dates;
}

const count = (value: number) => Math.round(value).toLocaleString("ja-JP");

/** 「10月23日」 */
export function monthDay(dateKey: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${month}月${day}日`;
}

function alertsFor(
  plan: PlannedSchedule,
  serials: readonly PlannedSchedule[],
  context: PlanContext
): string[] {
  const alerts: string[] = [];
  if (plan.detached) {
    alerts.push("作品目標設定の応募先が外れています。スケジュールごと消すか、応募先を入れ直してください");
    return alerts;
  }
  if (plan.milestonePassed) {
    alerts.push(`${plan.milestoneLabel}（${monthDay(plan.milestone!)}）を過ぎました`);
  } else if (plan.shortageDays > 0) {
    alerts.push(`間に合いません（あと${plan.shortageDays}日足りない）`);
  }
  if (plan.milestone === null && plan.earliestMilestone) {
    alerts.push(`${plan.milestoneLabel}は未定（最短で${monthDay(plan.earliestMilestone)}）`);
  }
  for (const step of plan.steps) {
    if (step.overlapDays > 0) {
      alerts.push(`「${step.step.label}」の期日が、あとの段と${step.overlapDays}日重なっています`);
    }
    if (step.step.status === "done") continue;
    if (step.daysSource === "noPace") {
      alerts.push(`「${step.step.label}」は直近30日の執筆の記録が無いので、仮の${step.days}日です`);
    } else if (step.daysSource === "noTarget") {
      alerts.push(
        plan.schedule.kind === "webSerial"
          ? `「${step.step.label}」は1話の字数が決まっていないので、仮の${step.days}日です`
          : `「${step.step.label}」は予定の字数が決まっていないので、仮の${step.days}日です`
      );
    } else if (step.daysSource === "tooSlow") {
      alerts.push(`「${step.step.label}」はいまの速さでは10年を超えます`);
    }
  }
  const serial = plan.serial;
  if (serial) {
    if (serial.unscheduledReason) alerts.push(serial.unscheduledReason);
    alerts.push(`書き溜めの残り ${serial.stock}話`);
    if (serial.firstMiss) {
      alerts.push(
        `書き溜めが尽きる見込み：第${serial.firstMiss.episode}話（${monthDay(serial.firstMiss.date)}の投稿）までに書けません`
      );
    }
    if (serial.writingNote) alerts.push(serial.writingNote);
    const missed = serial.slots.filter((slot) => slot.state === "missed").length;
    if (missed > 0) alerts.push(`予定日を過ぎて未投稿の話が${missed}話あります`);
  }
  // 公募の期間と重なる連載（カクヨムコンの「期間中に○万字」）。目安
  if (plan.schedule.kind === "contest" && plan.milestone && plan.targetChars && !plan.milestonePassed) {
    for (const other of serials) {
      if (!other.serial) continue;
      const by = serialCharsBy(other.serial, plan.milestone, context);
      if (by === null) continue;
      const rest = plan.targetChars - by;
      alerts.push(
        rest > 0
          ? `「${other.name}」の予定では、締切までに投稿されるのは約${count(by)}字（予定の字数まであと${count(rest)}字。目安）`
          : `「${other.name}」の予定では、締切までに約${count(by)}字を投稿できます（予定の字数に届く見込み。目安）`
      );
    }
  }
  return alerts;
}
