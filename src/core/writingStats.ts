import {
  DailyStat,
  DeviceWritingStats,
  FileCountMap,
  FileCounts,
  WRITING_STATS_SCHEMA_VERSION,
  WritingBaseline,
  WritingMeasurement,
} from "../models/writingStats";
import { isValidDeviceId } from "./device";

/**
 * 執筆量の集計（設計書6.3）。
 *
 * VS Code APIに依存しない。日付の扱いと「何を執筆と数えるか」の判断は
 * 間違えても画面には出ないので、ここだけをテストで固められるようにする。
 */

/**
 * 日付が変わる時刻（既定は午前4時）。
 *
 * **深夜0時で切ると、夜中に書いた分が翌日へ回る。** 作者の感覚では
 * 「昨日の夜に書いた」ぶんなので、日付が変わったあとの数時間は前日に付ける。
 */
export const DEFAULT_DAY_BOUNDARY_HOUR = 4;

/** 週の始まり。0=日曜、1=月曜 */
export const DEFAULT_WEEK_START = 1;

/** 粒度ごとに既定で見せる本数 */
export const DEFAULT_SPANS = {
  daily: 30,
  weekly: 12,
  monthly: 12,
  yearly: 5,
} as const;

export type StatsGranularity = keyof typeof DEFAULT_SPANS;

export const GRANULARITY_LABELS: Record<StatsGranularity, string> = {
  daily: "日次",
  weekly: "週次",
  monthly: "月次",
  yearly: "年次",
};

/** まだ何も記録していない状態 */
export function emptyDeviceStats(deviceId: string): DeviceWritingStats {
  return {
    schemaVersion: WRITING_STATS_SCHEMA_VERSION,
    deviceId,
    days: [],
  };
}

/**
 * 保存された記録を読む。
 *
 * **壊れた記録は黙って捨てる。** 同期対象なので競合マーカーが混ざることがあり、
 * ここで例外を投げると執筆そのものが止まる。統計は失われても原稿は無事である。
 */
export function parseDeviceWritingStats(
  value: unknown
): DeviceWritingStats | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== WRITING_STATS_SCHEMA_VERSION) return undefined;
  if (typeof raw.deviceId !== "string" || !isValidDeviceId(raw.deviceId)) {
    return undefined;
  }
  if (!Array.isArray(raw.days)) return undefined;

  const days: DailyStat[] = [];
  for (const entry of raw.days) {
    const day = parseDailyStat(entry);
    // 1日が壊れていても、残りの日の記録は使える
    if (day) days.push(day);
  }
  days.sort((left, right) => left.date.localeCompare(right.date));

  return {
    schemaVersion: WRITING_STATS_SCHEMA_VERSION,
    deviceId: raw.deviceId,
    baseline: parseBaseline(raw.baseline),
    days,
  };
}

function parseDailyStat(value: unknown): DailyStat | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.date !== "string" || !isDayKey(raw.date)) return undefined;
  if (typeof raw.net !== "number" || !Number.isFinite(raw.net)) return undefined;
  if (typeof raw.gross !== "number" || !Number.isFinite(raw.gross)) {
    return undefined;
  }
  const saves =
    typeof raw.saves === "number" && Number.isFinite(raw.saves) ? raw.saves : 0;

  /*
    **知らない項目は捨てずに残す。** この記録は端末をまたいで同期され、
    同じ端末に前の版・先の版の拡張機能が入れ替わり立ち替わり入りうる。
    読んだときに落とすと、**書き戻した瞬間に先の版が足した情報が消える**
    （このファイルは読んで・足して・丸ごと書き直す作りである）。
  */
  const day = {
    ...raw,
    date: raw.date,
    net: raw.net,
    gross: raw.gross,
    saves,
  } as DailyStat;

  // **内訳だけは、壊れていたら黙って落とす。** 合計が正なので、
  // 内訳が無くても記録としては成り立つ（想像で埋めない）
  const files = parseFileCountMap(raw.files);
  if (files) day.files = files;
  else delete day.files;
  return day;
}

/**
 * ファイル別の内訳を読む。
 *
 * **1件ずつ確かめて、読めたものだけを通す。** ここが壊れているのは
 * 同期の競合か手編集なので、丸ごと捨てるより読める分を残すほうがよい。
 * 1件も読めなければ `undefined`（項目そのものを置かない）。
 */
function parseFileCountMap(value: unknown): FileCountMap | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const result: FileCountMap = {};
  let found = false;
  for (const key of Object.keys(raw)) {
    // 鍵はJSONから来る。原型（prototype）を書き換える鍵は受け取らない
    if (key === "" || key === "__proto__") continue;
    const entry = raw[key];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const counts = entry as Record<string, unknown>;
    if (typeof counts.net !== "number" || !Number.isFinite(counts.net)) continue;
    if (typeof counts.gross !== "number" || !Number.isFinite(counts.gross)) {
      continue;
    }
    result[key] = { net: counts.net, gross: counts.gross };
    found = true;
  }
  return found ? result : undefined;
}

function parseBaseline(value: unknown): WritingBaseline | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const numbers = ["net", "gross", "fileCount", "conflictedCount"] as const;
  for (const key of numbers) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) {
      return undefined;
    }
  }
  if (typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at))) {
    return undefined;
  }
  const baseline: WritingBaseline = {
    net: raw.net as number,
    gross: raw.gross as number,
    fileCount: raw.fileCount as number,
    conflictedCount: raw.conflictedCount as number,
    at: raw.at,
  };
  const files = parseFileCountMap(raw.files);
  if (files) baseline.files = files;
  return baseline;
}

/**
 * 記録に載せるファイルの鍵。**区切りは必ず `/` にする。**
 *
 * 同じ作品をWindowsとmacOSの両方で書くと、`本文\001.txt` と `本文/001.txt`
 * が別の鍵になり、**同じファイルの記録が2つに割れる**。records は端末ごとに
 * 分かれているが、読むときは全端末ぶんを合算する（設計書5.5.6）ので、
 * 鍵が揃っていないと合算した瞬間に取りこぼす。
 */
export function fileCountKey(relativePath: string): string {
  return relativePath.split("\\").join("/");
}

/** 内訳から1件を引く。原型（prototype）の持ち物を拾わない */
function fileCountsOf(
  files: FileCountMap | undefined,
  key: string
): FileCounts | undefined {
  if (!files) return undefined;
  if (!Object.prototype.hasOwnProperty.call(files, key)) return undefined;
  return files[key];
}

/** 記録が付かなかったときの理由 */
export type SkipReason =
  /** 初回。基準が無いので差が出せない */
  | "baseline"
  /** ファイルが増減した。書いた量ではないので数えない */
  | "structure_changed"
  /** 増減が無かった */
  | "no_change";

export interface RecordResult {
  stats: DeviceWritingStats;
  /** 今回加算した純文字数の増減 */
  delta: number;
  /** 加算したか */
  counted: boolean;
  reason?: SkipReason;
}

/**
 * 今の作品の姿を測り、前回との差を「その日の執筆量」として積む。
 *
 * **初回は数えない。** 基準が無い状態で差を取ると、既にある4万字を
 * 「今日書いた」ことにしてしまう。基準だけ置いて次回から数える。
 *
 * **ファイル数か競合数が変わっていたら数えない。** 増減の原因が執筆ではない
 * ためである。ダウンロードした本文を作品フォルダーへ入れれば数十万字が増え、
 * ファイルを消せば同じだけ減る。競合が起きた話は集計から外れる（`scanner.ts`）
 * ので、直った瞬間に数万字を書いたように見える。いずれも執筆量ではないので、
 * 基準を置き直すだけにする。
 */
export function recordMeasurement(
  stats: DeviceWritingStats,
  measurement: WritingMeasurement,
  options: { at?: Date; boundaryHour?: number } = {}
): RecordResult {
  const at = options.at ?? new Date();
  const baseline = toBaseline(measurement, at);

  if (!stats.baseline) {
    return {
      stats: { ...stats, baseline },
      delta: 0,
      counted: false,
      reason: "baseline",
    };
  }

  const structureChanged =
    stats.baseline.fileCount !== measurement.fileCount ||
    stats.baseline.conflictedCount !== measurement.conflictedCount;
  if (structureChanged) {
    return {
      stats: { ...stats, baseline },
      delta: 0,
      counted: false,
      reason: "structure_changed",
    };
  }

  const delta = measurement.net - stats.baseline.net;
  const grossDelta = measurement.gross - stats.baseline.gross;
  if (delta === 0 && grossDelta === 0) {
    return {
      stats: { ...stats, baseline },
      delta: 0,
      counted: false,
      reason: "no_change",
    };
  }

  const date = statsDayKey(at, options.boundaryHour);
  // **ファイル別の差も、ここでしか取れない。** 数えない回（初回・ファイルの
  // 増減）では基準を置き直すだけなので、内訳も同じように数えない
  const fileDeltas = fileDeltasBetween(stats.baseline.files, measurement.files);
  const days = [...stats.days];
  const index = days.findIndex((day) => day.date === date);
  if (index >= 0) {
    const current = days[index];
    // **知らない項目を落とさない**（先の版が足したものを消さない）
    days[index] = {
      ...current,
      date,
      net: current.net + delta,
      gross: current.gross + grossDelta,
      saves: current.saves + 1,
    };
    const files = addFileCounts(current.files, fileDeltas);
    if (files) days[index].files = files;
  } else {
    const day: DailyStat = { date, net: delta, gross: grossDelta, saves: 1 };
    if (fileDeltas) day.files = fileDeltas;
    days.push(day);
    days.sort((left, right) => left.date.localeCompare(right.date));
  }

  return {
    stats: { ...stats, baseline, days },
    delta,
    counted: true,
  };
}

/**
 * 記録の結果をファイルへ書くべきか。
 *
 * **増減が無かった回は書かない。** 設定資料や別フォルダーのファイルを
 * 保存しただけでも記録は走るので、そのたびに書き直すと、
 * 中身が同じなのに時刻だけ変わったファイルが毎回git差分に出る。
 * 何も書いていないのに「未コミットの変更がある」と言われ、
 * 取り込みが止まるようになる（`sessionStore.ts` と同じ理由）。
 */
export function shouldPersist(result: RecordResult): boolean {
  return result.reason !== "no_change";
}

/**
 * 記録を付けずに基準だけ置き直す。
 *
 * 別の環境で書いた分を取り込んだとき（git pull）に使う。取り込んだ量を
 * この環境の執筆量として数えてしまうと、**同じ文章を2台ぶん数える**ことになる。
 */
export function rebaseline(
  stats: DeviceWritingStats,
  measurement: WritingMeasurement,
  at: Date = new Date()
): DeviceWritingStats {
  return { ...stats, baseline: toBaseline(measurement, at) };
}

function toBaseline(
  measurement: WritingMeasurement,
  at: Date
): WritingBaseline {
  const baseline: WritingBaseline = {
    net: measurement.net,
    gross: measurement.gross,
    fileCount: measurement.fileCount,
    conflictedCount: measurement.conflictedCount,
    at: at.toISOString(),
  };
  // 渡されなかったときは項目ごと置かない（空の内訳と「内訳を持たない」を
  // 取り違えないため。次の回に「基準に無いパス」として素通りする）
  if (measurement.files) baseline.files = { ...measurement.files };
  return baseline;
}

/**
 * ファイルごとの増減。
 *
 * **基準にも現在にもあるパスだけを数える。** 片方にしか無いのは、
 * ファイルが増えた・消えた・名前が変わったということで、書いた量ではない
 * （作品合計で「ファイル数が変わった回は数えない」としているのと同じ理屈を、
 * 1件ずつに当てはめている）。名前を変えただけの原稿を「全部書いた／全部
 * 消した」と数えてしまうのを避ける。
 *
 * 増減のあったものが1件も無ければ `undefined`（空の内訳を積まない）。
 */
function fileDeltasBetween(
  before: FileCountMap | undefined,
  after: FileCountMap | undefined
): FileCountMap | undefined {
  if (!before || !after) return undefined;
  const deltas: FileCountMap = {};
  let found = false;
  for (const key of Object.keys(after)) {
    const previous = fileCountsOf(before, key);
    if (!previous) continue;
    const current = fileCountsOf(after, key);
    if (!current) continue;
    const net = current.net - previous.net;
    const gross = current.gross - previous.gross;
    if (net === 0 && gross === 0) continue;
    deltas[key] = { net, gross };
    found = true;
  }
  return found ? deltas : undefined;
}

/** その日の内訳へ、今回の増減を足し込む（元の内訳は書き換えない） */
function addFileCounts(
  current: FileCountMap | undefined,
  deltas: FileCountMap | undefined
): FileCountMap | undefined {
  if (!deltas) return current;
  const merged: FileCountMap = current ? { ...current } : {};
  for (const key of Object.keys(deltas)) {
    const delta = fileCountsOf(deltas, key);
    if (!delta) continue;
    const previous = fileCountsOf(merged, key);
    merged[key] = previous
      ? { net: previous.net + delta.net, gross: previous.gross + delta.gross }
      : { net: delta.net, gross: delta.gross };
  }
  return merged;
}

// ─── 日付の扱い ───

/**
 * その時刻がどの日の執筆になるかを決める。
 *
 * 作者の時計（ローカル時刻）で数える。UTCで切ると、日本時間の朝9時までが
 * 前日に付いてしまう。
 */
export function statsDayKey(
  at: Date,
  boundaryHour: number = DEFAULT_DAY_BOUNDARY_HOUR
): string {
  const shifted = new Date(
    at.getTime() - clampBoundaryHour(boundaryHour) * 3_600_000
  );
  return `${shifted.getFullYear()}-${pad2(shifted.getMonth() + 1)}-${pad2(
    shifted.getDate()
  )}`;
}

/** 設定値が壊れていても動くようにする。0〜12時のあいだに丸める */
export function clampBoundaryHour(hour: number): number {
  if (!Number.isFinite(hour)) return DEFAULT_DAY_BOUNDARY_HOUR;
  return Math.min(12, Math.max(0, Math.floor(hour)));
}

export function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * 日付の計算はUTCで行う。
 *
 * ローカル時刻の `Date` に日数を足すと、夏時間のある地域で1時間ずれて
 * 前日・翌日へ飛ぶことがある。日付の並びを作るだけなので、時差の無い
 * 物差しの上で数える。
 */
function parseDayKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDayKey(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate()
  )}`;
}

export function addDays(key: string, days: number): string {
  const date = parseDayKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDayKey(date);
}

/** その日が属する週の開始日。週次の集計キーになる */
export function weekStartKey(
  key: string,
  weekStart: number = DEFAULT_WEEK_START
): string {
  const date = parseDayKey(key);
  const start = ((weekStart % 7) + 7) % 7;
  const diff = (date.getUTCDay() - start + 7) % 7;
  return addDays(key, -diff);
}

export function monthKey(key: string): string {
  return key.slice(0, 7);
}

export function yearKey(key: string): string {
  return key.slice(0, 4);
}

// ─── 集計 ───

export interface StatsBucket {
  /** 集計キー（日次なら YYYY-MM-DD、月次なら YYYY-MM） */
  key: string;
  /** グラフの目盛りに出す短い表記 */
  label: string;
  net: number;
  gross: number;
  /** その区間で実際に書いた日数 */
  activeDays: number;
}

/**
 * 粒度ごとに束ねる。
 *
 * **書かなかった区間も0として並べる。** 書いた日だけを並べると、
 * 毎日書いているように見えてしまい、続いていないことに気づけない。
 */
export function aggregate(
  days: DailyStat[],
  granularity: StatsGranularity,
  options: { today: string; weekStart?: number; span?: number }
): StatsBucket[] {
  const weekStart = options.weekStart ?? DEFAULT_WEEK_START;
  const totals = new Map<string, { net: number; gross: number; activeDays: number }>();

  for (const day of days) {
    const key = bucketKeyFor(day.date, granularity, weekStart);
    const current = totals.get(key) ?? { net: 0, gross: 0, activeDays: 0 };
    current.net += day.net;
    current.gross += day.gross;
    // 「書いた日」は増えた日だけ。消しただけの日を執筆日には数えない
    if (day.net > 0) current.activeDays += 1;
    totals.set(key, current);
  }

  const keys = bucketKeys(
    granularity,
    options.today,
    weekStart,
    options.span ?? DEFAULT_SPANS[granularity],
    days
  );

  return keys.map((key) => {
    const value = totals.get(key) ?? { net: 0, gross: 0, activeDays: 0 };
    return {
      key,
      label: bucketLabel(key, granularity),
      net: value.net,
      gross: value.gross,
      activeDays: value.activeDays,
    };
  });
}

function bucketKeyFor(
  date: string,
  granularity: StatsGranularity,
  weekStart: number
): string {
  switch (granularity) {
    case "daily":
      return date;
    case "weekly":
      return weekStartKey(date, weekStart);
    case "monthly":
      return monthKey(date);
    case "yearly":
      return yearKey(date);
  }
}

function bucketKeys(
  granularity: StatsGranularity,
  today: string,
  weekStart: number,
  span: number,
  days: DailyStat[]
): string[] {
  const count = Math.max(1, Math.floor(span));

  if (granularity === "daily") {
    return range(count).map((offset) => addDays(today, offset - (count - 1)));
  }
  if (granularity === "weekly") {
    const current = weekStartKey(today, weekStart);
    return range(count).map((offset) =>
      addDays(current, (offset - (count - 1)) * 7)
    );
  }
  if (granularity === "monthly") {
    const [year, month] = monthKey(today).split("-").map(Number);
    return range(count).map((offset) => {
      const shifted = new Date(Date.UTC(year, month - 1 + offset - (count - 1), 1));
      return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}`;
    });
  }

  // 年次は「直近5年」では足りないことがある。記録のある年は必ず出す
  const currentYear = Number(yearKey(today));
  const years = days.map((day) => Number(yearKey(day.date)));
  const earliest = Math.min(currentYear - (count - 1), ...years);
  return range(currentYear - earliest + 1).map((offset) =>
    String(earliest + offset)
  );
}

function bucketLabel(key: string, granularity: StatsGranularity): string {
  switch (granularity) {
    case "daily": {
      const [, month, day] = key.split("-");
      return `${Number(month)}/${Number(day)}`;
    }
    case "weekly": {
      const [, month, day] = key.split("-");
      return `${Number(month)}/${Number(day)}〜`;
    }
    case "monthly": {
      const [year, month] = key.split("-");
      return `${year}年${Number(month)}月`;
    }
    case "yearly":
      return `${key}年`;
  }
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/**
 * 全端末の記録を日ごとに合算する。
 *
 * 同じ人が環境を渡り歩いて書いている以上、**合算値こそが本人の総執筆量**
 * になる（設計書5.5.6）。
 */
export function mergeDailyStats(sets: DeviceWritingStats[]): DailyStat[] {
  const merged = new Map<string, DailyStat>();
  for (const set of sets) {
    for (const day of set.days) {
      const current = merged.get(day.date);
      if (current) {
        current.net += day.net;
        current.gross += day.gross;
        current.saves += day.saves;
        // 内訳も同じ日で足し合わせる。**片方にしか無くても落とさない**
        // （新しい端末だけが内訳を持っている、という状態が普通にありうる）
        const files = addFileCounts(current.files, day.files);
        if (files) current.files = files;
      } else {
        // **浅い写しでは足りない。** 内訳をそのまま持つと、足し込みが
        // 元の記録（読み込んだ配列）まで書き換える
        const copy: DailyStat = { ...day };
        if (day.files) copy.files = { ...day.files };
        merged.set(day.date, copy);
      }
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.date.localeCompare(right.date)
  );
}

/**
 * その日、そのファイルで書いた純文字数（設計書6.3）。
 *
 * 原稿エディタの下段に「今日 +560字」を出すために使う（作者の指示、
 * 2026-08-29）。**内訳を持たない日は 0 を返す。** この機能より前に
 * 書いた日には内訳が無く、そこへ作品合計を代わりに出すと
 * 「このファイルで書いた量」ではなくなる。
 */
export function fileNetOn(
  days: readonly DailyStat[],
  date: string,
  key: string
): number {
  for (const day of days) {
    if (day.date !== date) continue;
    return fileCountsOf(day.files, key)?.net ?? 0;
  }
  return 0;
}

/** 端末ごとの内訳。「自宅では書けているが外では進まない」が見える */
export function deviceTotals(
  sets: DeviceWritingStats[],
  options: { from?: string } = {}
): Array<{ deviceId: string; net: number; activeDays: number }> {
  return sets
    .map((set) => {
      const days = options.from
        ? set.days.filter((day) => day.date >= options.from!)
        : set.days;
      return {
        deviceId: set.deviceId,
        net: days.reduce((sum, day) => sum + day.net, 0),
        activeDays: days.filter((day) => day.net > 0).length,
      };
    })
    .sort((left, right) => right.net - left.net);
}

/**
 * ラベル付きの系列（作品・端末など）ごとの合計。
 *
 * `deviceTotals` は端末専用だが、全作品の執筆量パネルでは
 * 「作品ごとの内訳」を同じ形で出したい。系列の中身（誰の記録か）を
 * 問わない形にして、両方から使えるようにしている。
 */
export function totalsByLabel(
  entries: Array<{ label: string; days: DailyStat[] }>
): Array<{ label: string; net: number; activeDays: number }> {
  return entries
    .map((entry) => ({
      label: entry.label,
      net: entry.days.reduce((sum, day) => sum + day.net, 0),
      activeDays: entry.days.filter((day) => day.net > 0).length,
    }))
    .sort((left, right) => right.net - left.net);
}

/** 期間を指定して合計する。両端を含む */
export function sumRange(
  days: DailyStat[],
  from: string,
  to: string
): { net: number; gross: number; activeDays: number } {
  let net = 0;
  let gross = 0;
  let activeDays = 0;
  for (const day of days) {
    if (day.date < from || day.date > to) continue;
    net += day.net;
    gross += day.gross;
    if (day.net > 0) activeDays += 1;
  }
  return { net, gross, activeDays };
}

/**
 * 連続して書いている日数。
 *
 * 今日まだ書いていなくても、昨日まで続いていれば途切れたことにしない。
 * 朝いちばんに開いた瞬間「0日」と出ると、続いている実感まで消えてしまう。
 */
export function currentStreak(days: DailyStat[], today: string): number {
  const written = new Set(
    days.filter((day) => day.net > 0).map((day) => day.date)
  );
  let cursor = written.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (written.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// ─── 目標 ───

export interface GoalProgress {
  written: number;
  /** 0なら目標未設定 */
  goal: number;
  /** 目標までの残り。達成済みなら0 */
  remaining: number;
  /** 達成率（%）。目標未設定なら0 */
  rate: number;
  achieved: boolean;
}

export function progressAgainstGoal(written: number, goal: number): GoalProgress {
  const target = Number.isFinite(goal) && goal > 0 ? Math.floor(goal) : 0;
  if (target === 0) {
    return { written, goal: 0, remaining: 0, rate: 0, achieved: false };
  }
  const remaining = Math.max(0, target - written);
  return {
    written,
    goal: target,
    remaining,
    rate: Math.round((written / target) * 100),
    achieved: written >= target,
  };
}

/** その月の日数。月間目標の残りペースを出すのに使う */
export function daysInMonth(monthKeyValue: string): number {
  const [year, month] = monthKeyValue.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 月間目標に届かせるために、残りの日で1日あたり何字書けばよいか。
 *
 * 最終日にまだ残っていれば、その日で全部という意味で残り字数を返す。
 */
export function dailyPaceNeeded(
  remaining: number,
  today: string
): number | null {
  if (remaining <= 0) return null;
  const total = daysInMonth(monthKey(today));
  const day = Number(today.slice(8, 10));
  const remainingDays = Math.max(1, total - day + 1);
  return Math.ceil(remaining / remainingDays);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
