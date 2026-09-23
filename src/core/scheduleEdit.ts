import {
  MAX_STEP_DAYS,
  type Schedule,
  type ScheduleFile,
  type ScheduleStep,
  type SerialRule,
  type StepStatus,
} from "../models/schedule";
import { isDateKey } from "../models/workGoals";
import { goalsContestSchedule, GOALS_CONTEST_SCHEDULE_ID, type IdMaker } from "./scheduleTemplates";

/**
 * スケジュールの書き換え（設計書6.111.2）。**元のファイルは書き換えず、新しいものを返す**
 * ——保存に失敗したときに、画面の中だけが進んだ状態を作らないため（投稿状態の台帳と同じ流儀）。
 *
 * 画面（WebView）から来た値はここで確かめる。形が合わなければ例外を投げ、
 * 呼び出し側が作者へそのまま見せる（日本語の文にしてある）。
 *
 * VS Code API には依存しない。
 */

export interface StepPatch {
  readonly label?: string;
  readonly days?: number;
  /** 手で入れる期日。null で外す（逆算に戻す） */
  readonly due?: string | null;
  readonly status?: StepStatus;
  readonly note?: string;
}

export interface SchedulePatch {
  readonly name?: string;
  readonly milestone?: string | null;
  readonly targetChars?: number | null;
  readonly note?: string;
  readonly serial?: Partial<SerialRule>;
}

/**
 * 画面の上だけにある「応募先に従う公募」（`sch_goals`）を、書き換えの前にファイルへ下ろす。
 * 作者が段を直したときに初めて書く（設計書6.111.6）。
 */
export function materializeGoalsSchedule(file: ScheduleFile, scheduleId: string, now: string): ScheduleFile {
  if (scheduleId !== GOALS_CONTEST_SCHEDULE_ID) return file;
  if (file.schedules.some((schedule) => schedule.id === scheduleId)) return file;
  return { ...file, schedules: [goalsContestSchedule(now), ...file.schedules] };
}

export function addSchedule(file: ScheduleFile, schedule: Schedule): ScheduleFile {
  if (schedule.followsGoals && file.schedules.some((entry) => entry.followsGoals)) {
    throw new Error("作品目標設定の応募先に従う公募は、もうあります。");
  }
  return { ...file, schedules: [...file.schedules, schedule] };
}

export function removeSchedule(file: ScheduleFile, scheduleId: string): ScheduleFile {
  findSchedule(file, scheduleId);
  return { ...file, schedules: file.schedules.filter((schedule) => schedule.id !== scheduleId) };
}

export function updateSchedule(
  file: ScheduleFile,
  scheduleId: string,
  patch: SchedulePatch,
  now: string
): ScheduleFile {
  return mapSchedule(file, scheduleId, (schedule) => {
    const next: Schedule = { ...schedule, updatedAt: now };
    if (patch.name !== undefined) {
      if (schedule.followsGoals) throw new Error("応募先に従う公募の名前は、作品目標設定で直してください。");
      const name = patch.name.trim();
      if (!name) throw new Error("名前を入れてください。");
      next.name = name;
    }
    if (patch.milestone !== undefined) {
      if (schedule.followsGoals) throw new Error("応募先に従う公募の締切は、作品目標設定で直してください。");
      next.milestone = checkDate(patch.milestone, "日付");
    }
    if (patch.targetChars !== undefined) {
      if (schedule.followsGoals) throw new Error("応募先に従う公募の字数は、作品目標設定で直してください。");
      next.targetChars = checkCount(patch.targetChars, "予定の字数");
    }
    if (patch.note !== undefined) next.note = patch.note;
    if (patch.serial !== undefined) {
      if (!schedule.serial) throw new Error("連載の決まりはWEB連載だけにあります。");
      next.serial = checkSerial({ ...schedule.serial, ...patch.serial });
    }
    return next;
  });
}

export function updateStep(
  file: ScheduleFile,
  scheduleId: string,
  stepId: string,
  patch: StepPatch,
  today: string,
  now: string
): ScheduleFile {
  return mapSchedule(file, scheduleId, (schedule) => {
    const index = schedule.steps.findIndex((step) => step.id === stepId);
    if (index < 0) throw new Error("その段が見つかりません。画面を開き直してください。");
    const step = schedule.steps[index];
    const next: ScheduleStep = { ...step };
    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (!label) throw new Error("段の名前を入れてください。");
      next.label = label;
    }
    if (patch.days !== undefined) next.days = checkDays(patch.days);
    if (patch.due !== undefined) next.due = checkDate(patch.due, "期日");
    if (patch.note !== undefined) next.note = patch.note;
    if (patch.status !== undefined && patch.status !== step.status) {
      next.status = patch.status;
      // 済みにした日を残す。済みを外したら消す（済んでいない段に済んだ日は無い）
      next.doneAt = patch.status === "done" ? today : null;
    }
    const steps = [...schedule.steps];
    steps[index] = next;
    return { ...schedule, steps, updatedAt: now };
  });
}

/**
 * 段を足す。`afterStepId` の後ろへ（null なら先頭）。**時間の順**に並んでいるので、
 * 置く場所が逆算の順になる。
 */
export function addStep(
  file: ScheduleFile,
  scheduleId: string,
  input: { label: string; days: number; afterStepId: string | null },
  makeId: IdMaker,
  now: string
): ScheduleFile {
  const label = input.label.trim();
  if (!label) throw new Error("段の名前を入れてください。");
  const days = checkDays(input.days);
  return mapSchedule(file, scheduleId, (schedule) => {
    const at =
      input.afterStepId === null
        ? 0
        : schedule.steps.findIndex((step) => step.id === input.afterStepId) + 1;
    if (at === 0 && input.afterStepId !== null) throw new Error("その段が見つかりません。画面を開き直してください。");
    const step: ScheduleStep = {
      id: makeId("stp"),
      key: "custom",
      label,
      days,
      due: null,
      status: "todo",
      doneAt: null,
      note: "",
    };
    const steps = [...schedule.steps];
    steps.splice(at, 0, step);
    return { ...schedule, steps, updatedAt: now };
  });
}

export function removeStep(file: ScheduleFile, scheduleId: string, stepId: string, now: string): ScheduleFile {
  return mapSchedule(file, scheduleId, (schedule) => {
    if (!schedule.steps.some((step) => step.id === stepId)) {
      throw new Error("その段が見つかりません。画面を開き直してください。");
    }
    return { ...schedule, steps: schedule.steps.filter((step) => step.id !== stepId), updatedAt: now };
  });
}

/** 段を1つ上（前）・下（後ろ）へ動かす。端なら何もしない */
export function moveStep(
  file: ScheduleFile,
  scheduleId: string,
  stepId: string,
  direction: -1 | 1,
  now: string
): ScheduleFile {
  return mapSchedule(file, scheduleId, (schedule) => {
    const index = schedule.steps.findIndex((step) => step.id === stepId);
    if (index < 0) throw new Error("その段が見つかりません。画面を開き直してください。");
    const target = index + direction;
    if (target < 0 || target >= schedule.steps.length) return schedule;
    const steps = [...schedule.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    return { ...schedule, steps, updatedAt: now };
  });
}

function mapSchedule(
  file: ScheduleFile,
  scheduleId: string,
  change: (schedule: Schedule) => Schedule
): ScheduleFile {
  findSchedule(file, scheduleId);
  return {
    ...file,
    schedules: file.schedules.map((schedule) => (schedule.id === scheduleId ? change(schedule) : schedule)),
  };
}

function findSchedule(file: ScheduleFile, scheduleId: string): Schedule {
  const found = file.schedules.find((schedule) => schedule.id === scheduleId);
  if (!found) throw new Error("そのスケジュールが見つかりません。画面を開き直してください。");
  return found;
}

function checkDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_STEP_DAYS) {
    throw new Error(`日数は1〜${MAX_STEP_DAYS}の整数で入れてください。`);
  }
  return value;
}

function checkDate(value: unknown, label: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !isDateKey(value)) {
    throw new Error(`${label}は YYYY-MM-DD の形で入れてください。`);
  }
  return value;
}

function checkCount(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label}は0以上の整数で入れてください。`);
  }
  return value === 0 ? null : value;
}

function checkSerial(rule: SerialRule): SerialRule {
  const weekdays = [...new Set(rule.weekdays)].sort((a, b) => a - b);
  if (weekdays.length === 0 || !weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
    throw new Error("更新する曜日を1つ以上選んでください。");
  }
  if (rule.time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) {
    throw new Error("時刻は HH:MM の形で入れてください。");
  }
  if (!Number.isInteger(rule.bufferEpisodes) || rule.bufferEpisodes < 0) {
    throw new Error("書き溜めの話数は0以上の整数で入れてください。");
  }
  if (!Number.isInteger(rule.firstEpisode) || rule.firstEpisode < 1) {
    throw new Error("始めの話数は1以上の整数で入れてください。");
  }
  const endEpisode = checkCount(rule.endEpisode, "完結予定の話数");
  if (endEpisode !== null && endEpisode < rule.firstEpisode) {
    throw new Error("完結予定の話数が、始めの話数より前です。");
  }
  return {
    ...rule,
    weekdays,
    endEpisode,
    endDate: checkDate(rule.endDate, "終わりの日"),
    charsPerEpisode: checkCount(rule.charsPerEpisode, "1話の字数"),
  };
}
