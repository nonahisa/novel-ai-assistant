import {
  ALL_READER_STATS_METRICS,
  type ReaderStatsPeriod,
  type ReaderStatsRecord,
} from "../models/posting";
import { latestEpisodeValues } from "./readerRates";

/**
 * 執筆量パネルの「サイトの記録」に出すPVのグラフ（作者の依頼、2026-09-23）。
 *
 * 組むのは**グラフに載せる点の並び**だけで、描くのは画面の側である
 * （執筆量のグラフと同じSVGの作り）。
 *
 * ## 台帳は1件も捨てない・書き換えない
 *
 * 台帳は追記だけなので、同じ日・同じ話が何度も入っている。グラフの1点には
 * **いちばん新しい取り込みの値**を採る——畳むのは見せ方だけである。
 *
 * ## 材料の無いグラフは出さない
 *
 * 点が1つも無いグラフは `null` にする（画面は節ごと出さない）。カクヨムは
 * 年ごとの数を出さないので、年のグラフはふつう出ない。
 *
 * VS Code API には依存しない。
 */

export interface ReaderChartPoint {
  /** 並べる鍵（話数・"2026-09-05"・読み取り日時） */
  key: string;
  /** 目盛りに出す短い名前 */
  label: string;
  value: number;
  /** 印を付ける点か（各話のグラフの「基準の話」） */
  marked?: boolean;
}

export interface ReaderChart {
  points: ReaderChartPoint[];
}

export interface ReaderCharts {
  /**
   * 話ごとのPV（横＝話数）。**各話の、その話の最新の記録**（率と同じ拾い方。
   * アクセス数ページは50話ずつなので、1回の取り込みが全話を持つとは限らない）
   */
  episodes: ReaderChart | null;
  day: ReaderChart | null;
  month: ReaderChart | null;
  year: ReaderChart | null;
  /** 作品全体のPV（その時点の値）を、取り込みの日時ごとに（累計の伸び） */
  total: ReaderChart | null;
  /**
   * 日・月・年ごとの**増減**（ブックマーク・評価ポイント。残課題 B11 の続き）。
   * **材料のある組だけ**が、欄の順（台帳の表の順）・日→月→年の順に並ぶ。
   * 値は負のこともある（ブックマークが外された日）。無ければ空の配列
   */
  changes: ReaderChangeChart[];
}

/** 増減のグラフ1つ（どの欄の、どの粒度か） */
export interface ReaderChangeChart extends ReaderChart {
  /** 台帳の欄の名前（`bookmarks`・`narou_ratingPoints`） */
  metric: string;
  /** 画面に出す欄の名前（「ブックマーク」。台帳の表のまま） */
  label: string;
  /** 数のあとに付ける単位（評価ポイントの「pt」）。無ければ空 */
  unit: string;
  period: Exclude<ReaderStatsPeriod, "total">;
}

/**
 * 増減として描く欄（台帳の表で `dailyChange` の印がある欄）。
 *
 * **一覧を写さない。** 台帳の表（`ALL_READER_STATS_METRICS`）が唯一の置き場で、
 * 負を受ける欄とグラフに描く欄が食い違わないようにする。
 */
const CHANGE_METRICS = ALL_READER_STATS_METRICS.filter(
  (info) => info.dailyChange === true
);

const CHART_PERIODS: readonly Exclude<ReaderStatsPeriod, "total">[] = [
  "day",
  "month",
  "year",
];

/**
 * そのサイトのグラフを組む。
 *
 * @param records **1つのサイトの**記録。**台帳に書かれた順**で渡す
 *   （同じ日時に2件あるとき、あとから足したほうを採るため）
 * @param baseEpisode 基準の話（`computeReaderRates` が選んだもの）。印を付ける
 */
export function buildReaderCharts(
  records: readonly ReaderStatsRecord[],
  baseEpisode: number | null
): ReaderCharts {
  return {
    episodes: episodeChart(records, baseEpisode),
    day: periodChart(records, "day"),
    month: periodChart(records, "month"),
    year: periodChart(records, "year"),
    total: totalChart(records),
    changes: CHANGE_METRICS.flatMap((info) =>
      CHART_PERIODS.flatMap((period): ReaderChangeChart[] => {
        const chart = periodChart(records, period, info.key);
        return chart
          ? [
              {
                ...chart,
                metric: info.key,
                label: info.label,
                unit: info.unit ?? "",
                period,
              },
            ]
          : [];
      })
    ),
  };
}

function episodeChart(
  records: readonly ReaderStatsRecord[],
  baseEpisode: number | null
): ReaderChart | null {
  const points: ReaderChartPoint[] = [
    ...latestEpisodeValues(records).pv.entries(),
  ]
    .sort(([left], [right]) => left - right)
    .map(([episode, entry]) => ({
      key: String(episode),
      label: String(episode),
      value: entry.value,
      ...(episode === baseEpisode ? { marked: true } : {}),
    }));
  if (points.length === 0) return null;
  return { points };
}

/**
 * 日・月・年の作品全体の数（既定はPV）。**同じ期間は、いちばん新しい取り込みの値**。
 *
 * 期間の見出しは「2026-09-05」の形に揃えてあるので、文字列の順に並べれば
 * 日付の順になる。
 *
 * **足し合わせない。** 増減（ブックマーク・評価ポイント）も同じ拾い方をする
 * ——Narou.fun の日ごとの表もカクヨムの日ごとのPVも直近30日なので、毎日
 * 取り込むと同じ日が何度も台帳に入る（数が同じなら取り込みの側で積まないが、
 * サイトが数え直した日・今日の数が伸びた日は2件になる。直す前の版で積まれた
 * 重複も台帳に残っている）。足すと同じ日の数が二重に数えられる。
 */
function periodChart(
  records: readonly ReaderStatsRecord[],
  period: Exclude<ReaderStatsPeriod, "total">,
  metric = "pv"
): ReaderChart | null {
  const byKey = new Map<string, { value: number; time: number }>();
  for (const record of records) {
    if (record.scope !== "work" || record.period !== period) continue;
    const key = record.periodKey;
    const value = record.metrics[metric];
    if (key === undefined || value === undefined) continue;
    const time = Date.parse(record.readAt);
    // 日時の読めない行は、どちらが新しいか決められないので使わない
    if (Number.isNaN(time)) continue;
    const found = byKey.get(key);
    // 同じ日時ならあとから足したほう（`>=`）
    if (!found || time >= found.time) byKey.set(key, { value, time });
  }
  if (byKey.size === 0) return null;
  const points = [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => ({
      key,
      label: periodLabel(period, key),
      value: entry.value,
    }));
  return { points };
}

/** 目盛りの名前。日は「9/5」、月は「2026/09」、年は「2026」 */
function periodLabel(
  period: Exclude<ReaderStatsPeriod, "total">,
  key: string
): string {
  if (period === "day") {
    const parts = key.split("-");
    return parts.length === 3
      ? `${Number(parts[1])}/${Number(parts[2])}`
      : key;
  }
  if (period === "month") return key.replace("-", "/");
  return key;
}

/**
 * 作品全体のPV（その時点の値）を、取り込みの日時の順に。
 *
 * **1回の取り込みが1点。** 同じ日時に2件あれば、あとから足したほうを採る。
 */
function totalChart(records: readonly ReaderStatsRecord[]): ReaderChart | null {
  const byTime = new Map<number, { readAt: string; value: number }>();
  for (const record of records) {
    if (record.scope !== "work" || record.period !== undefined) continue;
    const value = record.metrics.pv;
    if (value === undefined) continue;
    const time = Date.parse(record.readAt);
    if (Number.isNaN(time)) continue;
    byTime.set(time, { readAt: record.readAt, value });
  }
  if (byTime.size === 0) return null;
  const points = [...byTime.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => ({
      key: entry.readAt,
      label: localMonthDay(entry.readAt),
      value: entry.value,
    }));
  return { points };
}

/**
 * 「9/23」（手元の時計で）。画面の日時（`formatWhen`）も手元の時計で
 * 出しているので、そちらと揃える。
 */
function localMonthDay(value: string): string {
  const when = new Date(value);
  return `${when.getMonth() + 1}/${when.getDate()}`;
}
