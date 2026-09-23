/**
 * 作品のスケジュール（設計書6.111）。
 *
 * `設定/スケジュール.json` に作品ごとに1つ置く。設定フォルダーは作品の git に
 * 入るので、**GitHub 同期で機器間を行き来する**（同期の仕組みは新しく作らない）。
 *
 * ここにあるのは**作者が決めたこと**だけである——種類・名前・マイルストーンの日付・
 * 段取り（段の名前・日数・手で入れた期日・状態・メモ）・連載の決まり。
 * 逆算した日付は**持たない**（毎回 `core/schedulePlan.ts` が計算する）。
 * 持つと、作者が期日を直したあとも古い日付が残り、どちらが正しいか分からなくなる。
 *
 * **壊れたJSONを直さない。** 読めなければ例外を投げ、呼び出し側が作者へ伝える（規則2）。
 *
 * VS Code API には依存しない（`models` の約束）。
 */

import { isDateKey } from "./workGoals";
import { POSTING_SITES, type PostingSiteId } from "./posting";

export const SCHEDULE_FILE = "スケジュール.json";
export const SCHEDULE_SCHEMA_VERSION = "1";

export type ScheduleKind = "contest" | "selfPublish" | "publisher" | "webSerial";

export const SCHEDULE_KINDS: readonly ScheduleKind[] = [
  "contest",
  "selfPublish",
  "publisher",
  "webSerial",
];

export const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  contest: "公募",
  selfPublish: "自費出版",
  publisher: "出版社",
  webSerial: "WEB連載",
};

/** マイルストーンの呼び名（種類ごと） */
export const MILESTONE_LABELS: Record<ScheduleKind, string> = {
  contest: "締切",
  selfPublish: "発売日",
  publisher: "発売日",
  webSerial: "連載開始日",
};

export type StepStatus = "todo" | "doing" | "done";

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  todo: "未着手",
  doing: "進行中",
  done: "済み",
};

/**
 * 段の印。雛形の段はそれぞれの印を持ち、作者が足した段は `custom`。
 *
 * **執筆の段（`write`・`serialBuffer`）だけ、日数を巡航速度から出す**
 * （`isPaceStepKey`）。印で見分けるのは、名前を作者が書き換えても
 * 「字数から日数を出す段」であることは変わらないため。
 */
export type StepKey =
  | "write"
  | "revise"
  | "finalCheck"
  | "cover"
  | "proof"
  | "submitFiles"
  | "storeReview"
  | "meeting"
  | "rewrite"
  | "firstProof"
  | "secondProof"
  | "sample"
  | "serialBuffer"
  | "serialPrep"
  | "custom";

const STEP_KEYS: readonly StepKey[] = [
  "write",
  "revise",
  "finalCheck",
  "cover",
  "proof",
  "submitFiles",
  "storeReview",
  "meeting",
  "rewrite",
  "firstProof",
  "secondProof",
  "sample",
  "serialBuffer",
  "serialPrep",
  "custom",
];

export function isPaceStepKey(key: StepKey): boolean {
  return key === "write" || key === "serialBuffer";
}

/** 段の所要日数の上限。巡航速度の完成予定（6.3.6.3）と同じ10年 */
export const MAX_STEP_DAYS = 3650;

export interface ScheduleStep {
  id: string;
  key: StepKey;
  label: string;
  /**
   * 所要日数（1〜3650）。執筆の段では**巡航速度が無いときの仮の日数**。
   */
  days: number;
  /**
   * 作者が手で入れた期日（その段を終える日）。**逆算はこれを上書きしない。**
   * 無ければ null。
   */
  due: string | null;
  status: StepStatus;
  /** 済みにした日（`YYYY-MM-DD`）。済みでなければ null */
  doneAt: string | null;
  note: string;
}

/** WEB連載の決まり（設計書6.111.5） */
export interface SerialRule {
  /**
   * 更新する曜日（0=日〜6=土）。毎日なら7つ全部。**空は許さない**
   * （更新しない連載は予定を並べられない）。
   */
  weekdays: number[];
  /** 更新の時刻（`HH:MM`）。表示だけに使う。無ければ null */
  time: string | null;
  /** 開始までに書き溜める話数（0以上） */
  bufferEpisodes: number;
  /** 連載の第何話から始めるか（1以上） */
  firstEpisode: number;
  /** 完結予定の話数。無ければ null */
  endEpisode: number | null;
  /** 終わりの日付。無ければ null */
  endDate: string | null;
  /** 1話の字数。無ければ作品目標設定の1記事の目標、それも無ければ書いた話の平均 */
  charsPerEpisode: number | null;
  /** 投稿の記録をどのサイトで見るか。無ければどれか1つに出していれば投稿済み */
  site: PostingSiteId | null;
}

export const DEFAULT_BUFFER_EPISODES = 5;

export interface Schedule {
  id: string;
  kind: ScheduleKind;
  /**
   * 名前（「○○賞」「Kindle版」「カクヨム連載」）。
   * `followsGoals` の公募では持たない（空文字）——作品目標設定の応募先の名前を毎回読む。
   */
  name: string;
  /**
   * 作品目標設定の応募先に従う公募か（設計書6.111.6）。
   * true なら名前・締切・字数は `goals.json` から読み、ここには写さない（二重に持たない）。
   */
  followsGoals: boolean;
  /** マイルストーンの日付（締切・発売日・連載開始日）。未定は null */
  milestone: string | null;
  /** 予定の字数。無ければ null（執筆の段は仮の日数になる） */
  targetChars: number | null;
  steps: ScheduleStep[];
  /** WEB連載だけが持つ */
  serial: SerialRule | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleFile {
  schemaVersion: string;
  schedules: Schedule[];
}

export function emptyScheduleFile(): ScheduleFile {
  return { schemaVersion: SCHEDULE_SCHEMA_VERSION, schedules: [] };
}

/**
 * 作者が手で編集したかもしれないJSONを検証する。**壊れていれば例外を投げる。**
 *
 * 知らない種類・段の印・状態は「壊れている」とする（黙って既定に寄せると、
 * 新しい版が書いた値を古い版が別の意味で読み、保存で書き換えてしまう）。
 */
export function parseScheduleFile(raw: unknown): ScheduleFile {
  const value = asObject(raw, "スケジュール");
  if (!Array.isArray(value.schedules)) fail("schedules は配列にしてください。");
  const schedules = value.schedules.map((entry, index) =>
    parseSchedule(entry, `schedules[${index}]`)
  );
  const ids = new Set<string>();
  for (const schedule of schedules) {
    if (ids.has(schedule.id)) fail(`スケジュールのID「${schedule.id}」が重なっています。`);
    ids.add(schedule.id);
  }
  return {
    schemaVersion:
      typeof value.schemaVersion === "string" ? value.schemaVersion : SCHEDULE_SCHEMA_VERSION,
    schedules,
  };
}

function parseSchedule(raw: unknown, where: string): Schedule {
  const value = asObject(raw, where);
  const id = requireText(value.id, `${where}.id`);
  const kind = value.kind;
  if (typeof kind !== "string" || !SCHEDULE_KINDS.includes(kind as ScheduleKind)) {
    fail(`${where}.kind「${String(kind)}」は知らない種類です。`);
  }
  const followsGoals = value.followsGoals === true;
  if (followsGoals && kind !== "contest") {
    fail(`${where}: 作品目標設定に従えるのは公募だけです。`);
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!followsGoals && !name) fail(`${where}.name がありません。`);
  const milestone = optionalDate(value.milestone, `${where}.milestone`);
  const steps = Array.isArray(value.steps)
    ? value.steps.map((step, index) => parseStep(step, `${where}.steps[${index}]`))
    : fail(`${where}.steps は配列にしてください。`);
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.id)) fail(`${where}: 段のID「${step.id}」が重なっています。`);
    stepIds.add(step.id);
  }
  const serial =
    kind === "webSerial"
      ? parseSerial(value.serial, `${where}.serial`)
      : null;
  return {
    id,
    kind: kind as ScheduleKind,
    name,
    followsGoals,
    milestone: followsGoals ? null : milestone,
    targetChars: optionalCount(value.targetChars, `${where}.targetChars`),
    steps,
    serial,
    note: typeof value.note === "string" ? value.note : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

function parseStep(raw: unknown, where: string): ScheduleStep {
  const value = asObject(raw, where);
  const key = value.key;
  if (typeof key !== "string" || !STEP_KEYS.includes(key as StepKey)) {
    fail(`${where}.key「${String(key)}」は知らない段です。`);
  }
  const status = value.status;
  if (status !== "todo" && status !== "doing" && status !== "done") {
    fail(`${where}.status「${String(status)}」は知らない状態です。`);
  }
  const days = value.days;
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > MAX_STEP_DAYS
  ) {
    fail(`${where}.days は1〜${MAX_STEP_DAYS}の整数にしてください。`);
  }
  return {
    id: requireText(value.id, `${where}.id`),
    key: key as StepKey,
    label: requireText(value.label, `${where}.label`),
    days,
    due: optionalDate(value.due, `${where}.due`),
    status,
    doneAt: optionalDate(value.doneAt, `${where}.doneAt`),
    note: typeof value.note === "string" ? value.note : "",
  };
}

function parseSerial(raw: unknown, where: string): SerialRule {
  const value = asObject(raw, where);
  const weekdays = value.weekdays;
  if (
    !Array.isArray(weekdays) ||
    weekdays.length === 0 ||
    !weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  ) {
    fail(`${where}.weekdays（更新する曜日）は0（日）〜6（土）の数を1つ以上並べてください。`);
  }
  const time = value.time;
  if (time != null && (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    fail(`${where}.time は HH:MM の形にしてください。`);
  }
  const buffer = value.bufferEpisodes;
  if (buffer != null && (typeof buffer !== "number" || !Number.isInteger(buffer) || buffer < 0)) {
    fail(`${where}.bufferEpisodes は0以上の整数にしてください。`);
  }
  const first = value.firstEpisode;
  if (first != null && (typeof first !== "number" || !Number.isInteger(first) || first < 1)) {
    fail(`${where}.firstEpisode は1以上の整数にしてください。`);
  }
  const site = value.site;
  if (site != null && (typeof site !== "string" || !POSTING_SITES.some((entry) => entry.id === site))) {
    fail(`${where}.site「${String(site)}」は知らない投稿先です。`);
  }
  const firstEpisode = typeof first === "number" ? first : 1;
  const endEpisode = optionalCount(value.endEpisode, `${where}.endEpisode`);
  if (endEpisode !== null && endEpisode < firstEpisode) {
    fail(`${where}.endEpisode が始めの話数より前です。`);
  }
  return {
    // 同じ曜日が2つあっても意味は変わらない。並びも揃える（保存の差分を小さく）
    weekdays: [...new Set(weekdays as number[])].sort((a, b) => a - b),
    time: typeof time === "string" ? time : null,
    bufferEpisodes: typeof buffer === "number" ? buffer : DEFAULT_BUFFER_EPISODES,
    firstEpisode,
    endEpisode,
    endDate: optionalDate(value.endDate, `${where}.endDate`),
    charsPerEpisode: optionalCount(value.charsPerEpisode, `${where}.charsPerEpisode`),
    site: typeof site === "string" ? (site as PostingSiteId) : null,
  };
}

function asObject(raw: unknown, where: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${where}の形式が正しくありません。`);
  }
  return raw as Record<string, unknown>;
}

function requireText(raw: unknown, where: string): string {
  if (typeof raw !== "string" || !raw.trim()) fail(`${where} がありません。`);
  return raw.trim();
}

function optionalDate(raw: unknown, where: string): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || !isDateKey(raw)) {
    fail(`${where}「${String(raw)}」は YYYY-MM-DD の形で書いてください。`);
  }
  return raw;
}

function optionalCount(raw: unknown, where: string): number | null {
  if (raw == null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    fail(`${where} は0以上の数にしてください。`);
  }
  // 0は「決めていない」と同じ（作品目標設定と同じ読み）
  return raw === 0 ? null : Math.round(raw);
}

function fail(message: string): never {
  throw new Error(message);
}
