import {
  isPaceStepKey,
  MAX_STEP_DAYS,
  MILESTONE_LABELS,
  SCHEDULE_KIND_LABELS,
  type Schedule,
  type ScheduleFile,
  type ScheduleStep,
  type SerialRule,
} from "../models/schedule";
import { addDays } from "./writingStats";
import { goalsContestSchedule } from "./scheduleTemplates";

/**
 * スケジュールの逆算（設計書6.111.3・6.111.5）。
 *
 * マイルストーン（締切・発売日・連載開始日）の前日を最後の段の終わりにして、
 * 後ろの段から前へ詰める。**逆算した日付はファイルに持たない**——毎回ここで出す。
 *
 * | 何を | どう決めたか |
 * |---|---|
 * | 手で入れた期日 | 段の終わりを固定し、その前の段はそこから逆算。**上書きしない**（規則2） |
 * | 済んだ段 | 逆算の鎖から外す（もう時間を使わない）。済んだ日の1日の帯として描く |
 * | 執筆の日数 | （予定の字数 − 今の字数）÷ 巡航速度、切り上げ。速度が0なら**割らない**（仮の日数） |
 * | 間に合わない | 未着手で始まりが今日より前・進行中で終わりが今日より前、の最大の日数 |
 * | マイルストーンが無い | 逆算せず、今日から前へ詰める（「最短で○月○日」） |
 *
 * 日付は `YYYY-MM-DD` のまま UTC の暦で足し引きする（`addDays`）。時差や夏時間の影響を受けない。
 *
 * VS Code API には依存しない。
 */

/** 公募の応募先（作品目標設定から読んだもの） */
export interface GoalsContestRef {
  readonly name: string;
  readonly deadline: string;
  /** 予定の字数（下限、無ければ上限。`targetCharsOf`） */
  readonly targetChars: number | null;
}

/** 連載の計算に使う、話ごとの事実（features が走査と投稿の記録から作る） */
export interface EpisodeFact {
  readonly chapter: number;
  /** 本文があるか（予定の話＝単話プロットだけの話は false） */
  readonly written: boolean;
  /** 投稿済みか */
  readonly posted: boolean;
  /** 本文の字数（書いていなければ0） */
  readonly chars: number;
  /** 題（本文の題か、予定の話の単話プロットの題）。無ければ null */
  readonly title: string | null;
}

export interface PlanContext {
  readonly today: string;
  /** 作品全体のいまの字数 */
  readonly written: number;
  /** 巡航速度（1日あたりの字数）。記録が無ければ0 */
  readonly perDay: number;
  /** 作品目標設定の応募先。無ければ null */
  readonly goalsContest: GoalsContestRef | null;
  /** 作品目標設定の「1記事あたりの目標文字数」 */
  readonly perEpisodeGoal: number | null;
  /** 話ごとの事実（話数の順でなくてよい） */
  readonly episodes: readonly EpisodeFact[];
}

/** 執筆の段の日数を、どこから出したか */
export type DaysSource =
  /** 段の日数（作者が決めた・雛形のまま） */
  | "fixed"
  /** 巡航速度と字数から */
  | "pace"
  /** 巡航速度が無いので仮 */
  | "noPace"
  /** 予定の字数（1話の字数）が無いので仮 */
  | "noTarget"
  /** 10年を超えるので止めた */
  | "tooSlow";

export interface PlannedStep {
  readonly step: ScheduleStep;
  /** 始まりの日。終わりより後なら長さ0（字数に届いている執筆の段） */
  readonly start: string;
  readonly end: string;
  /** 使った日数 */
  readonly days: number;
  readonly daysSource: DaysSource;
  /** 手で入れた期日が、あとの段と重なる日数（0なら重ならない） */
  readonly overlapDays: number;
  /** この段が遅れている日数（0なら遅れていない） */
  readonly lateDays: number;
}

export type SlotState = "posted" | "stocked" | "unwritten" | "missed";

export interface SerialSlot {
  readonly episode: number;
  readonly date: string;
  readonly state: SlotState;
  readonly title: string | null;
}

export interface SerialWriting {
  readonly episode: number;
  readonly start: string;
  readonly end: string;
  /** 投稿の前日までに書き終わらない */
  readonly late: boolean;
}

export interface SerialPlan {
  readonly slots: readonly SerialSlot[];
  readonly writing: readonly SerialWriting[];
  /** 書き溜めの残り（書いたが未投稿の話数） */
  readonly stock: number;
  /** 使った1話の字数。決まらなければ null */
  readonly charsPerEpisode: number | null;
  /** 書き溜めが尽きる最初の話（投稿の前日までに書けない見込み）。無ければ null */
  readonly firstMiss: { readonly episode: number; readonly date: string } | null;
  /** 予定を並べられなかった理由（開始日が未定など）。並べられれば null */
  readonly unscheduledReason: string | null;
  /** 執筆の帯を置けなかった理由（速度・1話の字数が無い）。置ければ null */
  readonly writingNote: string | null;
}

export interface PlannedSchedule {
  readonly schedule: Schedule;
  /** 画面に出す名前（応募先に従う公募は応募先の名前） */
  readonly name: string;
  readonly kindLabel: string;
  readonly milestoneLabel: string;
  /** マイルストーンの日付（応募先に従う公募は応募先の締切）。未定は null */
  readonly milestone: string | null;
  /** マイルストーンが未定のとき、今日から詰めた最短の日 */
  readonly earliestMilestone: string | null;
  readonly targetChars: number | null;
  readonly steps: readonly PlannedStep[];
  /** 間に合わない日数（0なら間に合う） */
  readonly shortageDays: number;
  /** マイルストーンが今日より前（連載を除く） */
  readonly milestonePassed: boolean;
  /** 応募先に従う公募なのに、作品目標設定の応募先が無い */
  readonly detached: boolean;
  /** 作品目標設定の応募先から、画面の上だけで作ったもの（ファイルにまだ無い） */
  readonly virtual: boolean;
  readonly serial: SerialPlan | null;
  /** 作業が発生しているか（設計書6.111.7） */
  readonly active: boolean;
}

/** 連載で、終わりの無いときに予定を並べる先（今日から1年） */
export const SERIAL_HORIZON_DAYS = 365;
/** 連載の予定の回数の上限 */
export const MAX_SERIAL_SLOTS = 800;

/**
 * ファイルのスケジュールに、作品目標設定の応募先を足す（設計書6.111.6）。
 *
 * 応募先があってファイルに「応募先に従う」公募がまだ無ければ、既定の段取りの公募を
 * **画面の上だけに**先頭へ置く（ファイルは作らない）。
 */
export function schedulesWithGoals(
  file: ScheduleFile,
  goalsContest: GoalsContestRef | null,
  now: string
): { schedule: Schedule; virtual: boolean }[] {
  const listed = file.schedules.map((schedule) => ({ schedule, virtual: false }));
  if (!goalsContest || file.schedules.some((schedule) => schedule.followsGoals)) return listed;
  return [{ schedule: goalsContestSchedule(now), virtual: true }, ...listed];
}

export function planSchedule(
  schedule: Schedule,
  context: PlanContext,
  virtual = false
): PlannedSchedule {
  const today = context.today;
  const goals = schedule.followsGoals ? context.goalsContest : null;
  const detached = schedule.followsGoals && goals === null;
  const milestone = schedule.followsGoals ? goals?.deadline ?? null : schedule.milestone;
  const targetChars = schedule.followsGoals ? goals?.targetChars ?? null : schedule.targetChars;
  const name = schedule.followsGoals
    ? goals?.name ?? "（応募先が外れています）"
    : schedule.name;

  const charsPerEpisode =
    schedule.kind === "webSerial" ? resolveCharsPerEpisode(schedule.serial, context) : null;

  const chain = schedule.steps.filter((step) => step.status !== "done");
  const sized = new Map(
    chain.map((step) => [step.id, stepDays(step, schedule, context, targetChars, charsPerEpisode)])
  );

  const placed = new Map<string, { start: string; end: string; overlapDays: number }>();
  let earliestMilestone: string | null = null;
  if (milestone !== null) {
    // 後ろの段から前へ詰める。最後の段の終わりはマイルストーンの前日
    let cursor = addDays(milestone, -1);
    for (let index = chain.length - 1; index >= 0; index--) {
      const step = chain[index];
      const days = sized.get(step.id)!.days;
      const end = step.due ?? cursor;
      const overlapDays = step.due !== null && step.due > cursor ? dayDiff(cursor, step.due) : 0;
      const start = addDays(end, -(days - 1));
      placed.set(step.id, { start, end, overlapDays });
      cursor = addDays(start, -1);
    }
  } else {
    // マイルストーンが未定：今日から前へ詰める
    let cursor = today;
    for (const step of chain) {
      const days = sized.get(step.id)!.days;
      const end = step.due ?? addDays(cursor, days - 1);
      const start = step.due ? addDays(step.due, -(days - 1)) : cursor;
      placed.set(step.id, { start, end, overlapDays: 0 });
      cursor = addDays(end, 1);
    }
    earliestMilestone = chain.length > 0 ? cursor : null;
  }

  // 連載は、開始日を過ぎたら開始前の段（書き溜め・準備）の遅れを数えない。
  // 開始後の遅れは、話ごとの執筆（書き溜めが尽きる見込み）が引き受ける
  const serialStarted =
    schedule.kind === "webSerial" && milestone !== null && milestone <= today;

  const steps: PlannedStep[] = schedule.steps.map((step) => {
    if (step.status === "done") {
      // 済んだ段は済んだ日の1日で描く（いつ始めたかは持っていない）
      const at = step.doneAt ?? today;
      return {
        step,
        start: at,
        end: at,
        days: 1,
        daysSource: "fixed",
        overlapDays: 0,
        lateDays: 0,
      };
    }
    const size = sized.get(step.id)!;
    const where = placed.get(step.id)!;
    const lateDays = serialStarted ? 0 : lateness(step, size.days, where, today);
    return {
      step,
      start: where.start,
      end: where.end,
      days: size.days,
      daysSource: size.source,
      overlapDays: where.overlapDays,
      lateDays,
    };
  });

  const shortageDays = steps.reduce((max, planned) => Math.max(max, planned.lateDays), 0);
  const milestonePassed =
    schedule.kind !== "webSerial" && milestone !== null && milestone < today;

  const serial =
    schedule.kind === "webSerial" && schedule.serial
      ? planSerial(schedule.serial, milestone, context, charsPerEpisode)
      : null;
  const serialHasFuture =
    serial !== null && serial.slots.some((slot) => slot.date >= today && slot.state !== "posted");

  const active =
    !detached &&
    ((!milestonePassed &&
      !serialStarted &&
      (chain.length > 0 || (schedule.steps.length === 0 && milestone !== null && milestone >= today))) ||
      serialHasFuture);

  return {
    schedule,
    name,
    kindLabel: SCHEDULE_KIND_LABELS[schedule.kind],
    milestoneLabel: MILESTONE_LABELS[schedule.kind],
    milestone,
    earliestMilestone,
    targetChars,
    steps,
    shortageDays,
    milestonePassed,
    detached,
    virtual,
    serial,
    active,
  };
}

/**
 * 段の遅れ。**執筆の段は状態を問わず「始まり」で見る**——残りの字数から日数を
 * 出しているので、書き進めれば始まりが後ろへ下がる。ほかの段は、未着手なら始まり、
 * 進行中なら終わりが今日より前かで見る。
 */
function lateness(
  step: ScheduleStep,
  days: number,
  where: { start: string; end: string },
  today: string
): number {
  if (days === 0) return 0;
  if (isPaceStepKey(step.key) || step.status === "todo") {
    return where.start < today ? dayDiff(where.start, today) : 0;
  }
  return where.end < today ? dayDiff(where.end, today) : 0;
}

function stepDays(
  step: ScheduleStep,
  schedule: Schedule,
  context: PlanContext,
  targetChars: number | null,
  charsPerEpisode: number | null
): { days: number; source: DaysSource } {
  if (!isPaceStepKey(step.key)) return { days: step.days, source: "fixed" };
  const remaining =
    step.key === "write"
      ? targetChars === null
        ? null
        : Math.max(0, targetChars - context.written)
      : bufferRemainingChars(schedule.serial, context, charsPerEpisode);
  return paceDays(remaining, context.perDay, step.days);
}

/**
 * 残りの字数から日数を出す。**0で割らない**（速度が無ければ仮の日数）。
 * 字数に届いていれば0日（長さ0の段）。
 */
export function paceDays(
  remaining: number | null,
  perDay: number,
  fallbackDays: number
): { days: number; source: DaysSource } {
  if (remaining === null) return { days: fallbackDays, source: "noTarget" };
  if (remaining <= 0) return { days: 0, source: "pace" };
  if (!Number.isFinite(perDay) || perDay <= 0) return { days: fallbackDays, source: "noPace" };
  const days = Math.ceil(remaining / perDay);
  if (days > MAX_STEP_DAYS) return { days: MAX_STEP_DAYS, source: "tooSlow" };
  return { days, source: "pace" };
}

/** 1話の字数：決まり → 作品目標設定の1記事の目標 → 書いた話の平均 */
export function resolveCharsPerEpisode(
  rule: SerialRule | null,
  context: Pick<PlanContext, "perEpisodeGoal" | "episodes">
): number | null {
  if (rule?.charsPerEpisode) return rule.charsPerEpisode;
  if (context.perEpisodeGoal) return context.perEpisodeGoal;
  const written = context.episodes.filter((episode) => episode.written && episode.chars > 0);
  if (written.length === 0) return null;
  return Math.round(written.reduce((sum, episode) => sum + episode.chars, 0) / written.length);
}

/** 書き溜めの話数のうち、まだ書いていない話の字数の合計 */
function bufferRemainingChars(
  rule: SerialRule | null,
  context: PlanContext,
  charsPerEpisode: number | null
): number | null {
  if (!rule) return null;
  const writtenChapters = new Set(
    context.episodes.filter((episode) => episode.written).map((episode) => episode.chapter)
  );
  let missing = 0;
  for (let chapter = rule.firstEpisode; chapter < rule.firstEpisode + rule.bufferEpisodes; chapter++) {
    if (!writtenChapters.has(chapter)) missing++;
  }
  if (missing === 0) return 0;
  return charsPerEpisode === null ? null : missing * charsPerEpisode;
}

/**
 * 連載の予定（設計書6.111.5）。
 *
 * 更新の決まりから投稿予定日を並べ、書き溜めより後のまだ書いていない話を、今日
 * （開始前なら開始日）から1話ずつ巡航速度で書くとして置く。**後ろから詰めない**——
 * 終わりの無い連載では、遅れの日数が先の話の数だけ膨らんで意味を持たないため。
 * 代わりに「投稿の前日までに書き終わらない最初の話」を出す。
 */
export function planSerial(
  rule: SerialRule,
  startDate: string | null,
  context: PlanContext,
  charsPerEpisode: number | null
): SerialPlan {
  const facts = new Map(context.episodes.map((episode) => [episode.chapter, episode]));
  const stock = context.episodes.filter(
    (episode) => episode.chapter >= rule.firstEpisode && episode.written && !episode.posted
  ).length;
  if (startDate === null) {
    return {
      slots: [],
      writing: [],
      stock,
      charsPerEpisode,
      firstMiss: null,
      unscheduledReason: "連載開始日が決まっていません",
      writingNote: null,
    };
  }

  const today = context.today;
  const slotDates = serialSlotDates(rule, startDate, today);
  const slots: SerialSlot[] = slotDates.map((date, index) => {
    const episode = rule.firstEpisode + index;
    const fact = facts.get(episode);
    const state: SlotState = fact?.posted
      ? "posted"
      : date < today
        ? "missed"
        : fact?.written
          ? "stocked"
          : "unwritten";
    return { episode, date, state, title: fact?.title ?? null };
  });

  // 書き溜めの話は開始前の段（書き溜めの執筆）が引き受ける。開始後は全部をここで見る
  const started = startDate <= today;
  const bufferEnd = rule.firstEpisode + rule.bufferEpisodes;
  const toWrite = slots.filter(
    (slot) =>
      slot.state === "unwritten" && (started || slot.episode >= bufferEnd)
  );
  const writing: SerialWriting[] = [];
  let firstMiss: SerialPlan["firstMiss"] = null;
  let writingNote: string | null = null;
  if (toWrite.length > 0) {
    if (charsPerEpisode === null) {
      writingNote = "1話の字数が決まっていないので、執筆の見込みを出せません";
    } else if (!(context.perDay > 0)) {
      writingNote = "直近30日の執筆の記録が無いので、執筆の見込みを出せません";
    } else {
      const simStart = started ? today : startDate;
      const need = charsPerEpisode / context.perDay;
      let elapsed = 0;
      for (const slot of toWrite) {
        const from = Math.floor(elapsed);
        elapsed += need;
        const to = Math.max(from, Math.ceil(elapsed) - 1);
        const start = addDays(simStart, from);
        const end = addDays(simStart, to);
        const late = end >= slot.date;
        if (late && firstMiss === null) firstMiss = { episode: slot.episode, date: slot.date };
        writing.push({ episode: slot.episode, start, end, late });
        // 遠すぎる先は描いても読めない（10年）。そこで止める
        if (to > MAX_STEP_DAYS) break;
      }
    }
  }

  return {
    slots,
    writing,
    stock,
    charsPerEpisode,
    firstMiss,
    unscheduledReason: null,
    writingNote,
  };
}

/**
 * 投稿予定日を並べる。終わり（話数・日付）が無ければ今日から1年先まで、最大800回。
 */
export function serialSlotDates(rule: SerialRule, startDate: string, today: string): string[] {
  const weekdays = new Set(rule.weekdays);
  if (weekdays.size === 0) return [];
  const horizon =
    rule.endDate ?? (rule.endEpisode === null ? addDays(maxDate(today, startDate), SERIAL_HORIZON_DAYS) : null);
  const maxSlots =
    rule.endEpisode === null
      ? MAX_SERIAL_SLOTS
      : Math.min(MAX_SERIAL_SLOTS, rule.endEpisode - rule.firstEpisode + 1);
  const dates: string[] = [];
  let date = startDate;
  // 曜日が1つでも週に1回は当たるので、日数の上限は回数×7で足りる
  for (let guard = 0; guard < maxSlots * 7 + 7 && dates.length < maxSlots; guard++) {
    if (horizon !== null && date > horizon) break;
    if (weekdays.has(weekdayOf(date))) dates.push(date);
    date = addDays(date, 1);
  }
  return dates;
}

/** 0=日〜6=土 */
export function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/**
 * 公募の締切までに、連載の予定で投稿される字数（設計書6.111.5）。目安。
 *
 * 投稿済みの話の字数＋締切の日までの未投稿の予定の回数 × 1話の字数。
 */
export function serialCharsBy(serial: SerialPlan, deadline: string, context: PlanContext): number | null {
  if (serial.charsPerEpisode === null || serial.unscheduledReason !== null) return null;
  const posted = context.episodes
    .filter((episode) => episode.posted)
    .reduce((sum, episode) => sum + episode.chars, 0);
  const upcoming = serial.slots.filter(
    (slot) => slot.state !== "posted" && slot.date >= context.today && slot.date <= deadline
  ).length;
  return posted + upcoming * serial.charsPerEpisode;
}

/** b − a の日数 */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
