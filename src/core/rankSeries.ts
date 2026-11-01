import {
  ALL_READER_STATS_METRICS,
  readerStatsInLedgerOrder,
  type PostingLedger,
  type PostingSiteId,
} from "../models/posting";

/**
 * 順位の推移（作者の指示 2026-11-02「順位もグラフにしてください」「他のサイトでも同様です」）。
 *
 * **材料は、そのサイトの順位のすべて**：
 *   - 手で記録した順位（「ランキング記録」。台帳の `rankings`）
 *   - なろう殿堂入りAPIで取った順位（`rankings` の `source: "narou-api"`）
 *   - ヘルパーが読んだ順位（読者の反応の指標のうち `lowerIsBetter` の欄。アルファポリスの
 *     累計・24時間の順位）——欄の名前を決め打ちせず、印のある欄をすべて拾う
 *
 * 線は**種別ごと**（「日間」「週間」…「累計ランキング」）。手の記録と API の記録が同じ種別
 * なら1本にまとめる（同じ板の順位である）。
 *
 * ## 圏外は線を切る（0 や大きな数で埋めない）
 *
 * 「その日に順位が無い」と分かるときだけ、点の代わりに `null` を置く。線はそこで切れる。
 *   - **API の順位**：殿堂入りAPIはランキングに入った日だけを返す。日間は毎日、週間は7日ごと、
 *     月間・四半期は月ごとに作られるので、**その間隔より空いた所は圏外**だった
 *   - **ヘルパーの順位**：同じ日に読んだ画面で、ほかの順位の欄はあるのにこの欄が無ければ圏外
 *   - **手の記録**：作者は気が向いたときに書き留めるので、書いていない日を圏外とは言えない。
 *     点どうしをそのまま結ぶ
 *
 * VS Code API に依存しない（グラフの形とお祝いの判定を、試験で確かめる）。
 */

export interface RankPoint {
  /** 日付（YYYY-MM-DD） */
  day: string;
  /** 順位。**null は圏外**（線を切る印） */
  rank: number | null;
}

export interface RankSeries {
  /** 種別の名前（線の凡例） */
  label: string;
  /** 古い順。同じ日は1つ（台帳であとに足した方） */
  points: RankPoint[];
}

/** API の順位の間隔（日）。これより空けば圏外とみなす */
const API_CADENCE_DAYS: Readonly<Record<string, number>> = {
  日間: 1,
  週間: 7,
  // 月間・四半期は毎月1日の順位だけが残る。月の長さの違いを見込んで31日
  月間: 31,
  四半期: 31,
};

/**
 * 日時から日付を取る。**時差の書いてある日時は、その時差の暦日**（API の順位は
 * 「その日の 0:00、日本時間」と書いてあり、手元の時差で前の日へずれないように）。
 * 書いていなければ手元の暦日。
 */
export function rankDayOf(iso: string): string | undefined {
  const explicit = /^(\d{4}-\d{2}-\d{2})T[0-9:.]+[+-]\d{2}:\d{2}$/.exec(iso);
  if (explicit) return explicit[1];
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return undefined;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

function addDay(day: string, days: number): string {
  const time = new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000);
  return time.toISOString().slice(0, 10);
}

interface Observation {
  day: string;
  rank: number | null;
  api: boolean;
  /** 台帳での並び（同じ日はあとの方を採る） */
  order: number;
}

/** そのサイトの順位の線を、種別ごとに組む（線の並びは最初に現れた順） */
export function buildRankSeries(ledger: PostingLedger, site: PostingSiteId): RankSeries[] {
  const byLabel = new Map<string, Observation[]>();
  let order = 0;
  const add = (label: string, observation: Omit<Observation, "order">): void => {
    const list = byLabel.get(label) ?? [];
    list.push({ ...observation, order: order++ });
    byLabel.set(label, list);
  };

  // 手の記録と API の順位（台帳の並びのまま。rankingsForSite は新しい順に並べ替えるので使わない）
  for (const entry of ledger.rankings) {
    if (entry.site !== site) continue;
    const day = rankDayOf(entry.recordedAt);
    if (!day) continue;
    add(entry.board, { day, rank: entry.rank, api: entry.source === "narou-api" });
  }

  // ヘルパーの順位（小さいほど良い欄）。その時点の値の、作品全体の行だけを見る
  const rankMetrics = ALL_READER_STATS_METRICS.filter((info) => info.lowerIsBetter === true);
  if (rankMetrics.length > 0) {
    for (const row of readerStatsInLedgerOrder(ledger, site)) {
      if (row.scope !== "work" || row.period !== undefined) continue;
      const present = rankMetrics.filter((info) => row.metrics[info.key] !== undefined);
      if (present.length === 0) continue;
      const day = rankDayOf(row.readAt);
      if (!day) continue;
      for (const info of rankMetrics) {
        const value = row.metrics[info.key];
        // 同じ画面でほかの順位は読めたのにこの欄が無い＝この板では圏外
        add(info.label, { day, rank: value === undefined ? null : value, api: false });
      }
    }
  }

  const series: RankSeries[] = [];
  for (const [label, observations] of byLabel) {
    // 同じ日はあとから足した方（同じ日に書き直した順位が勝つ）
    const perDay = new Map<string, Observation>();
    for (const observation of observations) {
      const held = perDay.get(observation.day);
      if (!held || observation.order >= held.order) perDay.set(observation.day, observation);
    }
    const sorted = [...perDay.values()].sort((left, right) => (left.day < right.day ? -1 : 1));
    const points: RankPoint[] = [];
    sorted.forEach((observation, index) => {
      const previous = sorted[index - 1];
      const cadence = API_CADENCE_DAYS[label];
      if (
        previous &&
        previous.api &&
        observation.api &&
        cadence !== undefined &&
        previous.rank !== null &&
        dayNumber(observation.day) - dayNumber(previous.day) > cadence
      ) {
        // 次に順位が出たはずの日には、もう入っていなかった
        points.push({ day: addDay(previous.day, cadence), rank: null });
      }
      points.push({ day: observation.day, rank: observation.rank });
    });
    // 圏外しか無い線は描かない（何も伝えない）
    if (points.some((point) => point.rank !== null)) series.push({ label, points });
  }
  return series;
}

/** 画面へ渡す順位のグラフ。線が1本も無ければ null（画面は案内の1行を出す） */
export interface RankChartData {
  series: RankSeries[];
  /** 横軸の端（日付） */
  firstDay: string;
  lastDay: string;
  /** 縦軸の端。**best が上**（1位がいちばん上）——画面は軸を上下逆にして描く */
  best: number;
  worst: number;
}

export function buildRankChart(ledger: PostingLedger, site: PostingSiteId): RankChartData | null {
  const series = buildRankSeries(ledger, site);
  if (series.length === 0) return null;
  const days = series.flatMap((line) => line.points.map((point) => point.day)).sort();
  const ranks = series.flatMap((line) =>
    line.points.flatMap((point) => (point.rank === null ? [] : [point.rank]))
  );
  return {
    series,
    firstDay: days[0],
    lastDay: days[days.length - 1],
    best: Math.min(...ranks),
    worst: Math.max(...ranks),
  };
}
