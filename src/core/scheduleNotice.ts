import { addDays } from "./writingStats";
import type { BoardColumn } from "./scheduleBoard";

/**
 * スケジュールの知らせ（設計書6.111.9）。**1日1回、まとめて1つ**だけ出す。
 *
 * 毎回出すと、作者は読まずに閉じるようになる。拾うのは「今日から明日にかけて
 * 手を動かすもの」と「もう遅れているもの」だけに絞る。
 *
 * VS Code API には依存しない。
 */

/** 期日が近いとみなす日数（今日を含めて） */
export const DUE_SOON_DAYS = 3;
/** マイルストーンが近いとみなす日数 */
export const MILESTONE_SOON_DAYS = 7;
/** 書き溜めが尽きるのを知らせる先 */
export const STOCK_WARN_DAYS = 14;

export interface ScheduleNoticeCounts {
  /** 未着手で今日か明日に始まる段 */
  readonly startingSoon: number;
  /** 済んでいない段で、期日（終わり）が3日以内 */
  readonly dueSoon: number;
  /** 7日以内のマイルストーン */
  readonly milestoneSoon: number;
  /** 間に合わない予定 */
  readonly late: number;
  /** 14日以内に書き溜めが尽きる連載 */
  readonly stockRunningOut: number;
}

export function collectScheduleNotices(
  columns: readonly BoardColumn[],
  today: string
): ScheduleNoticeCounts {
  const tomorrow = addDays(today, 1);
  const dueLimit = addDays(today, DUE_SOON_DAYS - 1);
  const milestoneLimit = addDays(today, MILESTONE_SOON_DAYS - 1);
  const stockLimit = addDays(today, STOCK_WARN_DAYS - 1);
  let startingSoon = 0;
  let dueSoon = 0;
  let milestoneSoon = 0;
  let late = 0;
  let stockRunningOut = 0;
  for (const column of columns) {
    for (const plan of column.plans) {
      if (!plan.active) continue;
      if (plan.shortageDays > 0) late++;
      if (plan.milestone && plan.milestone >= today && plan.milestone <= milestoneLimit) milestoneSoon++;
      if (plan.serial?.firstMiss && plan.serial.firstMiss.date <= stockLimit) stockRunningOut++;
      for (const step of plan.steps) {
        if (step.step.status === "done" || step.days === 0) continue;
        if (step.step.status === "todo" && (step.start === today || step.start === tomorrow)) startingSoon++;
        if (step.end >= today && step.end <= dueLimit) dueSoon++;
      }
    }
  }
  return { startingSoon, dueSoon, milestoneSoon, late, stockRunningOut };
}

/** 知らせの1文。何も無ければ null（その日は出さない） */
export function scheduleNoticeText(counts: ScheduleNoticeCounts): string | null {
  const parts: string[] = [];
  if (counts.late > 0) parts.push(`間に合わない予定が${counts.late}つ`);
  if (counts.stockRunningOut > 0) parts.push(`書き溜めが尽きそうな連載が${counts.stockRunningOut}つ`);
  if (counts.startingSoon > 0) parts.push(`今日・明日に始める段が${counts.startingSoon}つ`);
  if (counts.dueSoon > 0) parts.push(`期日が近い段が${counts.dueSoon}つ`);
  if (counts.milestoneSoon > 0) parts.push(`1週間以内の締切・発売日・連載開始が${counts.milestoneSoon}つ`);
  if (parts.length === 0) return null;
  return `スケジュール：${parts.join("・")}あります。`;
}
