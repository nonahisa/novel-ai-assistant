import {
  isPaceStepKey,
  MAX_STEP_DAYS,
  MILESTONE_LABELS,
  SCHEDULE_KIND_LABELS,
  stepActorOf,
  type Schedule,
  type ScheduleFile,
  type ScheduleStep,
  type SerialRule,
  type StepActor,
} from "../models/schedule";
import { addDays } from "./writingStats";
import { goalsContestSchedule } from "./scheduleTemplates";
import { dayCapacity, sharedSpeed, uniformCalendar, type WorkCalendar } from "./workCalendar";

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
 * | 作業量の割合（6.111.12） | 段の量（平均の日で数えた日数）に、日ごとの進み（割合 ÷ 割り戻しの平均）の合計が届くまでを段の長さにする。割合0の日は進まない |
 * | 並行（6.111.13） | 「同時に進められる」でつないだ段は1つの組になり、組の全員が同じ日に終わる（逆算）・同じ日に始まる（前へ詰める）。組の前後は「前の段が終わってから」 |
 * | 重なり（6.111.14） | 作者が手を動かす段が同じ日にk個あれば、1つあたりの進みは `(1 − 損)^(k−1) ÷ k`。人に頼む段は暦の日数で進み、重なりに数えない |
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
  /** 作業の暦（作業量の割合・祝日）。無ければ毎日同じだけ進む（0.83.0 までと同じ） */
  readonly calendar?: WorkCalendar;
}

/**
 * 作品をまたぐ重なり（`scheduleLoad.ts` が作る）。無ければ重ならないとして並べる。
 */
export interface LoadView {
  /** その日に、この作業（`taskKey`）のほかに作者が手を動かしている作業の数 */
  othersOn(taskKey: string, date: string): number;
  /** 重なり1つごとに落ちる割合 */
  readonly penalty: number;
}

export interface PlanOptions {
  readonly load?: LoadView;
  /** 作業の鍵の頭（作品ID）。作品をまたいで段を見分ける */
  readonly taskPrefix?: string;
}

/** 作業の鍵（重なりの数え分けに使う）。作品ID｜スケジュールID｜段ID */
export function taskKeyOf(prefix: string, scheduleId: string, stepId: string): string {
  return `${prefix}|${scheduleId}|${stepId}`;
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
  /** 使った日数（暦の日数。始まりから終わりまで） */
  readonly days: number;
  readonly daysSource: DaysSource;
  /** 手で入れた期日が、あとの段と重なる日数（0なら重ならない） */
  readonly overlapDays: number;
  /** この段が遅れている日数（0なら遅れていない） */
  readonly lateDays: number;
  /** 誰が動かすか */
  readonly actor: StepActor;
  /** 並行の組の中の何番目か（0から）。画面で帯を横に並べる */
  readonly track: number;
  /** 並行の組の大きさ（1なら並行なし） */
  readonly tracks: number;
  /**
   * この段の期間に、作者が手を動かす作業がいちばん多く重なった数（自分を含む）。
   * 1なら重ならない。人に頼む段は常に1
   */
  readonly peakLoad: number;
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
  virtual = false,
  options: PlanOptions = {}
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
    chain.map((step) => [step.id, stepUnits(step, schedule, context, targetChars, charsPerEpisode)])
  );
  const calendar = context.calendar ?? UNIFORM;
  const prefix = options.taskPrefix ?? "";
  const rateOf = (step: ScheduleStep): Pace =>
    paceFor(stepActorOf(step), calendar, options.load, taskKeyOf(prefix, schedule.id, step.id));

  const groups = parallelGroups(chain);
  const placed = new Map<string, Placed>();
  let earliestMilestone: string | null = null;
  if (milestone !== null) {
    // 後ろの組から前へ詰める。最後の組の終わりはマイルストーンの前日。
    // 組の全員が同じ日に終わり、組の中でいちばん早い始まりの前日が、前の組の終わり
    let cursor = addDays(milestone, -1);
    for (let index = groups.length - 1; index >= 0; index--) {
      let groupStart: string | null = null;
      for (const step of groups[index]) {
        const size = sized.get(step.id)!;
        const pace = rateOf(step);
        // 手で入れた期日は動かさない（規則2）。逆算の終わりは、休みの日なら前の作業日へ寄せる
        const end = step.due ?? (size.units > 0 ? lastWorkingDay(cursor, pace) : cursor);
        const overlapDays = step.due !== null && step.due > cursor ? dayDiff(cursor, step.due) : 0;
        const walk = walkBackward(end, size.units, pace);
        placed.set(step.id, { start: walk.start, end, overlapDays, truncated: walk.truncated, peak: walk.peak });
        if (groupStart === null || walk.start < groupStart) groupStart = walk.start;
      }
      if (groupStart !== null) cursor = addDays(groupStart, -1);
    }
  } else {
    // マイルストーンが未定：今日から前へ詰める。組の全員が同じ日に始まり、
    // 組の中でいちばん遅い終わりの翌日が、次の組の始まり
    let cursor = today;
    for (const group of groups) {
      let groupEnd: string | null = null;
      for (const step of group) {
        const size = sized.get(step.id)!;
        const pace = rateOf(step);
        let where: Placed;
        if (step.due) {
          const walk = walkBackward(step.due, size.units, pace);
          where = { start: walk.start, end: step.due, overlapDays: 0, truncated: walk.truncated, peak: walk.peak };
        } else {
          const start = size.units > 0 ? firstWorkingDay(cursor, pace) : cursor;
          const walk = walkForward(start, size.units, pace);
          where = { start, end: walk.end, overlapDays: 0, truncated: walk.truncated, peak: walk.peak };
        }
        placed.set(step.id, where);
        if (groupEnd === null || where.end > groupEnd) groupEnd = where.end;
      }
      if (groupEnd !== null) cursor = addDays(groupEnd, 1);
    }
    earliestMilestone = chain.length > 0 ? cursor : null;
  }
  const trackOf = new Map<string, { track: number; tracks: number }>();
  for (const group of groups) {
    group.forEach((step, track) => trackOf.set(step.id, { track, tracks: group.length }));
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
        actor: stepActorOf(step),
        track: 0,
        tracks: 1,
        peakLoad: 1,
      };
    }
    const size = sized.get(step.id)!;
    const where = placed.get(step.id)!;
    // 暦の日数（休みの日・重なりで、段の量より長くなることがある）。長さ0の段は0
    const days = size.units > 0 ? dayDiff(where.start, where.end) + 1 : 0;
    const lateDays = serialStarted ? 0 : lateness(step, days, where, today);
    const track = trackOf.get(step.id) ?? { track: 0, tracks: 1 };
    return {
      step,
      start: where.start,
      end: where.end,
      days,
      daysSource: where.truncated ? "tooSlow" : size.source,
      overlapDays: where.overlapDays,
      lateDays,
      actor: stepActorOf(step),
      track: track.track,
      tracks: track.tracks,
      peakLoad: where.peak,
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

/**
 * 段の量（平均の日で数えた日数。小数のまま）。決まった日数の段はその日数、
 * 執筆の段は残りの字数 ÷ 巡航速度。**0で割らない**（`paceDays` と同じ分け方）。
 */
function stepUnits(
  step: ScheduleStep,
  schedule: Schedule,
  context: PlanContext,
  targetChars: number | null,
  charsPerEpisode: number | null
): { units: number; source: DaysSource } {
  if (!isPaceStepKey(step.key)) return { units: step.days, source: "fixed" };
  const remaining =
    step.key === "write"
      ? targetChars === null
        ? null
        : Math.max(0, targetChars - context.written)
      : bufferRemainingChars(schedule.serial, context, charsPerEpisode);
  if (remaining === null) return { units: step.days, source: "noTarget" };
  if (remaining <= 0) return { units: 0, source: "pace" };
  const perDay = context.perDay;
  if (!Number.isFinite(perDay) || perDay <= 0) return { units: step.days, source: "noPace" };
  const units = remaining / perDay;
  // 切り上げた日数で上限を見る（`paceDays` と同じ判定。3650.5日は10年を超える）
  if (Math.ceil(units - EPSILON) > MAX_STEP_DAYS) return { units: MAX_STEP_DAYS, source: "tooSlow" };
  return { units, source: "pace" };
}

const UNIFORM = uniformCalendar();
/** 小数の足し算の誤差を吸う幅（1日の進みに比べて十分小さい） */
const EPSILON = 1e-9;

/** その日の進み（平均の日を1として）と、その日に重なっている作業の数（自分を含む） */
interface Pace {
  rate(date: string): number;
  load(date: string): number;
}

interface Placed {
  start: string;
  end: string;
  overlapDays: number;
  /** 10年を超えて止めたか */
  truncated: boolean;
  /** 重なりのいちばん多い数（自分を含む） */
  peak: number;
}

/**
 * 段の進み方。**人に頼む段は暦の日数で進み**（頼んだ先の暦で進む。作者の休む日にも、
 * 重なりにも従わない）、自分で進める段は作業の暦の進み × 重なりの速さ。
 */
function paceFor(actor: StepActor, calendar: WorkCalendar, load: LoadView | undefined, key: string): Pace {
  if (actor === "others") return { rate: () => 1, load: () => 1 };
  return {
    rate: (date) => {
      const capacity = dayCapacity(calendar, date);
      if (capacity === 0) return 0;
      const k = 1 + (load?.othersOn(key, date) ?? 0);
      return capacity * sharedSpeed(k, load?.penalty ?? 0);
    },
    load: (date) => (dayCapacity(calendar, date) === 0 ? 1 : 1 + (load?.othersOn(key, date) ?? 0)),
  };
}

/** 作業のできる日（進みが0でない日）まで遡る。1年探して無ければそのまま */
function lastWorkingDay(date: string, pace: Pace): string {
  let day = date;
  for (let guard = 0; guard < 366; guard++) {
    if (pace.rate(day) > 0) return day;
    day = addDays(day, -1);
  }
  return date;
}

function firstWorkingDay(date: string, pace: Pace): string {
  let day = date;
  for (let guard = 0; guard < 366; guard++) {
    if (pace.rate(day) > 0) return day;
    day = addDays(day, 1);
  }
  return date;
}

/**
 * 終わりの日から遡って、進みの合計が段の量に届く日を始まりにする。量が0なら長さ0
 * （始まり＝終わりの翌日。0.83.0 と同じ形）。10年ぶん遡っても届かなければそこで止める。
 */
function walkBackward(
  end: string,
  units: number,
  pace: Pace
): { start: string; truncated: boolean; peak: number } {
  if (units <= 0) return { start: addDays(end, 1), truncated: false, peak: 1 };
  let day = end;
  let total = 0;
  let peak = 1;
  for (let count = 1; count <= MAX_STEP_DAYS; count++) {
    const rate = pace.rate(day);
    if (rate > 0) peak = Math.max(peak, pace.load(day));
    total += rate;
    if (total >= units - EPSILON) return { start: day, truncated: false, peak };
    day = addDays(day, -1);
  }
  return { start: addDays(day, 1), truncated: true, peak };
}

function walkForward(
  start: string,
  units: number,
  pace: Pace
): { end: string; truncated: boolean; peak: number } {
  if (units <= 0) return { end: addDays(start, -1), truncated: false, peak: 1 };
  let day = start;
  let total = 0;
  let peak = 1;
  for (let count = 1; count <= MAX_STEP_DAYS; count++) {
    const rate = pace.rate(day);
    if (rate > 0) peak = Math.max(peak, pace.load(day));
    total += rate;
    if (total >= units - EPSILON) return { end: day, truncated: false, peak };
    day = addDays(day, 1);
  }
  return { end: addDays(day, -1), truncated: true, peak };
}

/**
 * 並行の組を作る（設計書6.111.13）。「同時に進められる」でつないだ段を1つの組にまとめ、
 * 組を**いちばん前の段の位置**に置く。組の中は段の並びのまま。
 *
 * つなぎ方が輪になっていても（AがBと、BがAと）同じ組になるだけで、たどり続けることは
 * ない（組分けの木は、小さい番号を根にして1回ずつつなぐだけ）。指す段が無い・済んだ・
 * 自分自身を指すつなぎは「前の段が終わってから」として扱う。
 */
export function parallelGroups(chain: readonly ScheduleStep[]): ScheduleStep[][] {
  const index = new Map(chain.map((step, at) => [step.id, at]));
  const parent = chain.map((_, at) => at);
  const root = (at: number): number => {
    let node = at;
    while (parent[node] !== node) node = parent[node];
    // 道を縮める（次に同じ段を訊いたときに、長い鎖をたどらない）
    let walk = at;
    while (parent[walk] !== node) {
      const next = parent[walk];
      parent[walk] = node;
      walk = next;
    }
    return node;
  };
  chain.forEach((step, at) => {
    const partner = step.parallelWith ? index.get(step.parallelWith) : undefined;
    if (partner === undefined || partner === at) return;
    const a = root(at);
    const b = root(partner);
    if (a === b) return;
    // 小さい番号を根にする（組の位置＝いちばん前の段、を決まった形で出すため）
    if (a < b) parent[b] = a;
    else parent[a] = b;
  });
  const groups = new Map<number, ScheduleStep[]>();
  chain.forEach((step, at) => {
    const key = root(at);
    const members = groups.get(key);
    if (members) members.push(step);
    else groups.set(key, [step]);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, members]) => members);
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
      // 進みの合計（`simStart` から i 日目の始まりまで）。作業の暦に従い、休みの日は進まない。
      // 毎日1なら i そのもので、0.83.0 の「切り捨て・切り上げ」と同じ日になる
      const calendar = context.calendar ?? UNIFORM;
      const cumulative: number[] = [0];
      const progressAt = (index: number): number => {
        while (cumulative.length <= index) {
          const day = cumulative.length - 1;
          cumulative.push(cumulative[day] + dayCapacity(calendar, addDays(simStart, day)));
        }
        return cumulative[index];
      };
      const limit = MAX_STEP_DAYS * 2;
      let elapsed = 0;
      let cursor = 0;
      for (const slot of toWrite) {
        const before = elapsed;
        elapsed += need;
        // 始まり：書き始めの位置を含む日。終わり：書き終わりの位置に届く日
        let from = cursor;
        while (from < limit && !(progressAt(from + 1) > before)) from++;
        let to = from;
        while (to < limit && !(progressAt(to + 1) >= elapsed)) to++;
        cursor = from;
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
