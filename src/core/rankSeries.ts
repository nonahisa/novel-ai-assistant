import {
  ALL_READER_STATS_METRICS,
  rankingBoardLabel,
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
 *   - ヘルパーがランキングの画面で読んだ順位（`rankings` の `source: "helper"`。2026-11-02）
 *
 * 線は**種別ごと**（「日間」「週間」…「累計ランキング」）。手の記録と API の記録が同じ種別
 * なら1本にまとめる（同じ板の順位である）。ヘルパーがランキングの画面で読んだ順位は
 * **区分（`board`）ごとに1本**で、線の名前は画面の見出し（`boardLabel`）。見出しが同じでも
 * 区分が違えば別の線にする（カクヨムのジャンル別は見出しが似る）。
 *
 * ## 線が多すぎるとき
 *
 * カクヨムはジャンル×期間で区分が多く、全部を描くと読めない。**グラフ（`buildRankChart`）だけ**、
 * 直近に記録のある線から `RANK_CHART_MAX_SERIES` 本を描き、残りは本数を返す（順位の表で見られる）。
 * お祝い（`detectRankEvents`）は `buildRankSeries` の全部の線を見る（描かない線の順位も祝う）。
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
  /**
   * 線の見分け（同じ見出しの別の区分を分ける）。手の記録・API・読者の反応の欄の線は
   * 名前と同じ。ヘルパーの順位は `helper:` ＋区分の鍵
   */
  key: string;
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
  const byKey = new Map<string, Observation[]>();
  const labels = new Map<string, string>();
  let order = 0;
  const add = (
    key: string,
    label: string,
    observation: Omit<Observation, "order">
  ): void => {
    const list = byKey.get(key) ?? [];
    list.push({ ...observation, order: order++ });
    byKey.set(key, list);
    // 見出しはあとから届いたもの（サイトが見出しを変えたら、いまの言い方で出す）
    labels.set(key, label);
  };

  // 手の記録と API の順位（台帳の並びのまま。rankingsForSite は新しい順に並べ替えるので使わない）
  for (const entry of ledger.rankings) {
    if (entry.site !== site) continue;
    const day = rankDayOf(entry.recordedAt);
    if (!day) continue;
    if (entry.source === "helper") {
      add(`helper:${entry.board}`, rankingBoardLabel(entry), { day, rank: entry.rank, api: false });
    } else {
      add(entry.board, entry.board, { day, rank: entry.rank, api: entry.source === "narou-api" });
    }
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
        add(info.label, info.label, { day, rank: value === undefined ? null : value, api: false });
      }
    }
  }

  const series: RankSeries[] = [];
  for (const [key, observations] of byKey) {
    const label = labels.get(key) ?? key;
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
    if (points.some((point) => point.rank !== null)) series.push({ label, key, points });
  }
  return disambiguateLabels(series);
}

/**
 * 同じ名前の線が2本以上あれば、ヘルパーの区分の線に区分の鍵を添えて見分ける
 * （凡例が同じ文字の2本だと、どちらの線か分からない）
 */
function disambiguateLabels(series: RankSeries[]): RankSeries[] {
  const counts = new Map<string, number>();
  for (const line of series) counts.set(line.label, (counts.get(line.label) ?? 0) + 1);
  return series.map((line) =>
    (counts.get(line.label) ?? 0) > 1 && line.key.startsWith("helper:")
      ? { ...line, label: `${line.label}（${line.key.slice("helper:".length)}）` }
      : line
  );
}

/**
 * グラフに描く線の上限（2026-11-02）。色の見分けがつき、凡例が2行ほどに収まる本数。
 * 残りの線は順位の表で見られる
 */
export const RANK_CHART_MAX_SERIES = 6;

/** 線のいちばん新しい順位の日（圏外の点は数えない） */
function lastRankedDay(line: RankSeries): string {
  for (let index = line.points.length - 1; index >= 0; index--) {
    if (line.points[index].rank !== null) return line.points[index].day;
  }
  return "";
}

/**
 * 描く線を選ぶ。**直近に順位のある線から**上限まで（同じ日なら順位の良い方）。並びは元の順
 * （凡例の並びが記録のたびに入れ替わらないように）
 */
export function pickRankChartSeries(
  series: readonly RankSeries[],
  limit: number = RANK_CHART_MAX_SERIES
): { shown: RankSeries[]; hidden: RankSeries[] } {
  if (series.length <= limit) return { shown: [...series], hidden: [] };
  const lastRank = (line: RankSeries): number => {
    for (let index = line.points.length - 1; index >= 0; index--) {
      const rank = line.points[index].rank;
      if (rank !== null) return rank;
    }
    return Number.POSITIVE_INFINITY;
  };
  const ranked = [...series].sort((left, right) => {
    const leftDay = lastRankedDay(left);
    const rightDay = lastRankedDay(right);
    if (leftDay !== rightDay) return leftDay < rightDay ? 1 : -1;
    return lastRank(left) - lastRank(right);
  });
  const chosen = new Set(ranked.slice(0, limit));
  return {
    shown: series.filter((line) => chosen.has(line)),
    hidden: series.filter((line) => !chosen.has(line)),
  };
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
  /** 描かなかった線の名前（上限を越えた分。画面は「ほか N 本は表で」と添える） */
  hiddenLabels: string[];
}

export function buildRankChart(ledger: PostingLedger, site: PostingSiteId): RankChartData | null {
  const all = buildRankSeries(ledger, site);
  if (all.length === 0) return null;
  const { shown: series, hidden } = pickRankChartSeries(all);
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
    hiddenLabels: hidden.map((line) => line.label),
  };
}
