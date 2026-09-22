import type { ReaderStatsRecord } from "../models/posting";

/**
 * 読者の反応から出す3つの率（作者の依頼、2026-09-23。約束 v1b）。
 *
 * - **離脱率** = 1 − 基準の話のPV ÷ 第1話のPV
 * - **ブックマーク率** = 作品全体のブックマーク ÷ 第1話のPV
 * - **評価率** = 作品全体のレビュー（評価した人数）÷ 第1話のPV
 *   （なろうは評価者数で割る——なろうの「レビュー」は書かれたレビューの件数。
 *   `ratingMetricFor`）
 *
 * **分母は第1話の読者**である（作者の訂正「ブックマーク率等は第一話読者
 * でした」、2026-09-23）。読みはじめた人のうち、何割がブックマーク・評価まで
 * 来たかを見る。
 *
 * **基準の話を使うのは離脱率だけ。** 基準の話は、最終更新（`updatedAt`）から
 * 読んだ時点までに72時間以上たっていた話のうち、話数がいちばん大きい話である。
 * 更新した直後の話はまだ読まれ切っていないので、そこを使うと離脱率が実際より
 * 高く見える。ブックマーク率・評価率は更新日が無くても出せる。
 *
 * ## 数を作らない
 *
 * **材料からの割り算だけ**をする。見込み・補間・0埋めはしない。材料が
 * 1つでも欠ければ、その率は出さずに**欠けた理由**を返す——「0%」と出すと、
 * 読めなかったのか本当に0だったのか区別が付かない。
 *
 * ## 話ごとに、その話のいちばん新しい記録を拾う
 *
 * 台帳は追記だけなので、同じ話が何度も入っている。しかも**1回の取り込みが
 * 全話を持つとは限らない**——作品管理ページは全話ぶん（更新日つき）だが、
 * アクセス数ページは50話ずつ（更新日なし）で、手入力なら1話だけのこともある。
 * 「いちばん新しい取り込み1回ぶん」で計算すると、あとからアクセス数ページを
 * 取り込んだだけで率が出なくなる（2026-09-23 の見直し）。
 *
 * そこで**話ごとに**拾う。
 *
 * - PV：その話の、PVを持つ記録のうち最新
 * - 最終更新：その話の、`updatedAt` を持つ記録のうち最新（PVと別の回でもよい）
 * - 3日の境目は、**その `updatedAt` と、それを持つ記録の `readAt`** で見る
 *   ——「サイトで最後に更新されてから、読んだ時点までに何日たっていたか」
 *
 * 話ごとの数が複数の取り込みにまたがったときは、どの話がいつの数かを
 * `episodeSources` で画面へ渡す（黙って混ぜない）。
 *
 * VS Code API には依存しない。
 */

/** 基準の話に要る「更新からの経過」。72時間ちょうどは含む */
export const READER_RATE_SETTLE_HOURS = 72;

/** 計算に使った実際の数1つ（画面で「611 ÷ 23,299」と出すため） */
export interface ReaderRateOperand {
  /** 「第1話のPV」「作品全体のブックマーク」 */
  label: string;
  value: number;
  /**
   * その数を読み取った日時。**話ごとのいちばん新しい取り込み
   * （`episodeReadAt`）と違う回の数を使ったときだけ**入る。
   */
  readAt?: string;
}

export interface ReaderRate {
  /** 「離脱率」「ブックマーク率」「評価率」 */
  label: string;
  /** 式を言葉で（「1 − 第219話のPV ÷ 第1話のPV」） */
  formula: string;
  /** 割合（0.026 なら 2.6%）。出せなければ undefined */
  value?: number;
  /** 「2.6%」 */
  percent?: string;
  /** 実際の数を入れた式（「611 ÷ 23,299 = 2.6%」） */
  expression?: string;
  /** 使った数。出せなかったときも、読めたぶんは入る */
  operands: ReaderRateOperand[];
  /** 出せなかった理由（「第1話のPVがありません」）。出せたら undefined */
  missing?: string;
}

/** 基準の話（離脱率にだけ使う） */
export interface ReaderRateBase {
  episode: number;
  /** その話のPV（その話の最新の記録）。記録に無ければ undefined */
  pv?: number;
  updatedAt: string;
  /** その `updatedAt` を持つ記録を読み取った日時（3日の境目はこれで見た） */
  updatedReadAt: string;
}

/** 話ごとの数が、どの取り込みから来たか（新しい順） */
export interface ReaderEpisodeSource {
  readAt: string;
  /** 「第1〜50話、第52話」 */
  episodes: string;
}

export interface ReaderRates {
  /**
   * 話ごとの記録のうち、いちばん新しい取り込みの日時。**話ごとの記録が
   * 1件も無ければ null**（そのときは画面が節ごと出さない）。
   */
  episodeReadAt: string | null;
  /**
   * 話ごとのPVが、どの取り込みから来たか（新しい順）。1回ぶんだけなら
   * 1件。画面はこれで「いつの数か」を言う。
   */
  episodeSources: ReaderEpisodeSource[];
  base: ReaderRateBase | null;
  /** 基準の話を決められなかった理由 */
  baseMissing?: string;
  dropout: ReaderRate;
  bookmark: ReaderRate;
  rating: ReaderRate;
}

/** 話ごとに拾った、その話の最新の記録 */
export interface LatestEpisodeValues {
  /** 話ごとの記録（粒度なし）のうち、いちばん新しい日時。無ければ undefined */
  newest?: { readAt: string; time: number };
  /** 話数 → その話の、PVを持つ最新の記録 */
  pv: Map<number, { value: number; readAt: string; time: number }>;
  /** 話数 → その話の、`updatedAt` を持つ最新の記録 */
  updated: Map<
    number,
    { updatedAt: string; updatedTime: number; readAt: string; time: number }
  >;
}

/**
 * 話ごとに、その話のいちばん新しい記録を拾う。
 *
 * **同じ日時に同じ話が2件あれば、あとから足したほう**を採る（台帳は追記
 * なので、あとにあるほうが新しい）。そのため `records` は台帳に書かれた順で
 * 受け取り、比べるときは `>=` にする。
 *
 * 日時の読めない行（手で書き換えた跡）は、前後を決められないので使わない。
 * 話数の読めない行は、どの話か分からないので使わない。
 */
export function latestEpisodeValues(
  records: readonly ReaderStatsRecord[]
): LatestEpisodeValues {
  const result: LatestEpisodeValues = { pv: new Map(), updated: new Map() };
  for (const record of records) {
    if (record.scope !== "episode" || record.period !== undefined) continue;
    const time = Date.parse(record.readAt);
    if (Number.isNaN(time)) continue;
    if (!result.newest || time > result.newest.time) {
      result.newest = { readAt: record.readAt, time };
    }
    const episode = record.episode;
    if (episode === undefined) continue;

    const pv = record.metrics.pv;
    if (pv !== undefined) {
      const found = result.pv.get(episode);
      if (!found || time >= found.time) {
        result.pv.set(episode, { value: pv, readAt: record.readAt, time });
      }
    }

    if (record.updatedAt !== undefined) {
      const updatedTime = Date.parse(record.updatedAt);
      if (!Number.isNaN(updatedTime)) {
        const found = result.updated.get(episode);
        if (!found || time >= found.time) {
          result.updated.set(episode, {
            updatedAt: record.updatedAt,
            updatedTime,
            readAt: record.readAt,
            time,
          });
        }
      }
    }
  }
  return result;
}

/**
 * そのサイトの記録から3つの率を出す。
 *
 * @param records **1つのサイトの**記録。**台帳に書かれた順**（古く足したもの
 *   が先）で渡す——同じ日時に同じ話が2件あるとき、あとから足したほうを採る
 */
export function computeReaderRates(
  records: readonly ReaderStatsRecord[]
): ReaderRates {
  const latest = latestEpisodeValues(records);
  const newest = latest.newest;
  // 「話ごとのいちばん新しい取り込み」と違う回の数にだけ、日時を添える
  const stamp = (readAt: string): { readAt?: string } =>
    newest && Date.parse(readAt) !== newest.time ? { readAt } : {};

  // ---- 第1話のPV（3つの率すべての分母） ----
  const first = latest.pv.get(1);
  const firstPv: ReaderRateOperand | undefined = first
    ? { label: "第1話のPV", value: first.value, ...stamp(first.readAt) }
    : undefined;
  const firstProblem = !newest
    ? "話ごとの記録がありません"
    : firstPv === undefined
      ? "第1話のPVがありません"
      : firstPv.value === 0
        ? "第1話のPVが0です（0では割れません）"
        : undefined;

  // ---- 基準の話（離脱率だけが使う） ----
  const baseResult = newest
    ? pickBaseEpisode(latest)
    : { base: null, missing: "話ごとの記録がありません" };
  const base = baseResult.base;
  const baseRecord = base ? latest.pv.get(base.episode) : undefined;
  const basePv: ReaderRateOperand | undefined =
    base && baseRecord
      ? {
          label: `第${base.episode}話のPV`,
          value: baseRecord.value,
          ...stamp(baseRecord.readAt),
        }
      : undefined;
  const baseProblem = !base
    ? baseResult.missing
    : basePv === undefined
      ? `第${base.episode}話のPVがありません`
      : undefined;

  // ---- 離脱率 ----
  const dropoutOperands = [basePv, firstPv].filter(isOperand);
  // 基準の話の問題を先に言う（更新日が無いのは、第1話より先に直す場所がある）
  const dropoutProblem = baseProblem ?? firstProblem;
  const dropout =
    dropoutProblem !== undefined || !basePv || !firstPv
      ? missingRate(
          "dropout",
          base?.episode,
          dropoutOperands,
          dropoutProblem ?? "材料が足りません"
        )
      : doneRate(
          "dropout",
          base?.episode,
          dropoutOperands,
          1 - basePv.value / firstPv.value,
          `1 − ${count(basePv.value)} ÷ ${count(firstPv.value)}`
        );

  const labels = workLabelsFor(records);
  const workOperand = (
    kind: "bookmark" | "rating"
  ): ReaderRateOperand | undefined => {
    const work = newestWorkMetric(
      records,
      kind === "bookmark" ? "bookmarks" : ratingMetricFor(records)
    );
    return work
      ? { label: labels[kind], value: work.value, ...stamp(work.readAt) }
      : undefined;
  };

  return {
    episodeReadAt: newest?.readAt ?? null,
    episodeSources: episodeSources(latest),
    base,
    ...(baseResult.missing ? { baseMissing: baseResult.missing } : {}),
    dropout,
    bookmark: ratioRate("bookmark", labels, workOperand("bookmark"), firstPv, firstProblem),
    rating: ratioRate("rating", labels, workOperand("rating"), firstPv, firstProblem),
  };
}

/**
 * 評価率の分子にする欄（「評価した人数」）。**サイトで違う**（残課題 B11）。
 *
 * カクヨムではレビュー人数（★を付けた人数）が評価した人数に当たるが、
 * なろうの「レビュー」は**書かれたレビューの件数**で、評価した人数は
 * 「評価者数」（`narou_raters`）である。Narou.fun からレビュー 0 が入ると、
 * レビューで割ったなろうの評価率は 0% になり、助言が「目安に届いていない」と言う。
 *
 * 1回の呼び出しに渡るのは**1つのサイトの**記録なので、最初の行のサイトで決める。
 */
function ratingMetricFor(
  records: readonly ReaderStatsRecord[]
): "reviews" | "narou_raters" {
  return records[0]?.site === "narou" ? "narou_raters" : "reviews";
}

/** 作品全体の数の呼び名。評価率の分子だけがサイトで変わる */
function workLabelsFor(
  records: readonly ReaderStatsRecord[]
): Record<"bookmark" | "rating", string> {
  return ratingMetricFor(records) === "narou_raters"
    ? { ...WORK_LABELS, rating: "作品全体の評価者数（評価した人数）" }
    : WORK_LABELS;
}

type RateKind = "dropout" | "bookmark" | "rating";

const RATE_LABELS: Record<RateKind, string> = {
  dropout: "離脱率",
  bookmark: "ブックマーク率",
  rating: "評価率",
};

/** 作品全体の数の呼び名（式と「◯◯がありません」に使う） */
const WORK_LABELS: Record<"bookmark" | "rating", string> = {
  bookmark: "作品全体のブックマーク",
  rating: "作品全体のレビュー（評価した人数）",
};

/** 式を言葉で。基準の話が決まっていなければ「基準の話」と書く */
function formulaOf(
  kind: RateKind,
  baseEpisode: number | undefined,
  labels: Record<"bookmark" | "rating", string> = WORK_LABELS
): string {
  if (kind === "dropout") {
    const base =
      baseEpisode === undefined ? "基準の話のPV" : `第${baseEpisode}話のPV`;
    return `1 − ${base} ÷ 第1話のPV`;
  }
  return `${labels[kind]} ÷ 第1話のPV`;
}

function missingRate(
  kind: RateKind,
  baseEpisode: number | undefined,
  operands: ReaderRateOperand[],
  missing: string,
  labels: Record<"bookmark" | "rating", string> = WORK_LABELS
): ReaderRate {
  return {
    label: RATE_LABELS[kind],
    formula: formulaOf(kind, baseEpisode, labels),
    operands,
    missing,
  };
}

function doneRate(
  kind: RateKind,
  baseEpisode: number | undefined,
  operands: ReaderRateOperand[],
  value: number,
  left: string,
  labels: Record<"bookmark" | "rating", string> = WORK_LABELS
): ReaderRate {
  const percent = formatPercent(value);
  return {
    label: RATE_LABELS[kind],
    formula: formulaOf(kind, baseEpisode, labels),
    value,
    percent,
    expression: `${left} = ${percent}`,
    operands,
  };
}

/** ブックマーク率・評価率（作品全体の数 ÷ 第1話のPV） */
function ratioRate(
  kind: "bookmark" | "rating",
  labels: Record<"bookmark" | "rating", string>,
  workOperand: ReaderRateOperand | undefined,
  firstPv: ReaderRateOperand | undefined,
  firstProblem: string | undefined
): ReaderRate {
  const operands = [workOperand, firstPv].filter(isOperand);
  const problem =
    workOperand === undefined ? `${labels[kind]}がありません` : firstProblem;
  if (problem !== undefined || !workOperand || !firstPv) {
    return missingRate(
      kind,
      undefined,
      operands,
      problem ?? "材料が足りません",
      labels
    );
  }
  return doneRate(
    kind,
    undefined,
    operands,
    workOperand.value / firstPv.value,
    `${count(workOperand.value)} ÷ ${count(firstPv.value)}`,
    labels
  );
}

function isOperand(
  value: ReaderRateOperand | undefined
): value is ReaderRateOperand {
  return value !== undefined;
}

/**
 * 基準の話を選ぶ。**更新から、それを読んだ時点までに72時間以上たっていた
 * 話のうち、話数が最大のもの。**
 */
function pickBaseEpisode(latest: LatestEpisodeValues): {
  base: ReaderRateBase | null;
  missing?: string;
} {
  const settleMs = READER_RATE_SETTLE_HOURS * 60 * 60 * 1000;
  let best: number | undefined;
  for (const [episode, entry] of latest.updated) {
    if (entry.time - entry.updatedTime < settleMs) continue;
    if (best === undefined || episode > best) best = episode;
  }
  if (best === undefined) {
    return {
      base: null,
      missing:
        latest.updated.size > 0
          ? `更新から${READER_RATE_SETTLE_HOURS / 24}日以上たった話がありません`
          : "更新日の分かる話がありません",
    };
  }
  const updated = latest.updated.get(best);
  const pv = latest.pv.get(best);
  if (!updated) return { base: null, missing: "更新日の分かる話がありません" };
  return {
    base: {
      episode: best,
      ...(pv === undefined ? {} : { pv: pv.value }),
      updatedAt: updated.updatedAt,
      updatedReadAt: updated.readAt,
    },
  };
}

/**
 * 作品全体の数（その時点の値）。**その欄を持つ記録のうち最新。**
 * 同じ日時に2件あれば、あとから足したほう。
 */
function newestWorkMetric(
  records: readonly ReaderStatsRecord[],
  key: "bookmarks" | "reviews" | "narou_raters"
): { value: number; readAt: string } | undefined {
  let newest: { value: number; readAt: string; time: number } | undefined;
  for (const record of records) {
    if (record.scope !== "work" || record.period !== undefined) continue;
    const value = record.metrics[key];
    if (value === undefined) continue;
    const time = Date.parse(record.readAt);
    if (Number.isNaN(time)) continue;
    if (!newest || time >= newest.time) {
      newest = { value, readAt: record.readAt, time };
    }
  }
  return newest ? { value: newest.value, readAt: newest.readAt } : undefined;
}

/**
 * 話ごとのPVが、どの取り込みから来たかをまとめる（新しい順）。
 *
 * 取り込みごとに、その回から拾った話数を「第1〜50話、第52話」の形に畳む。
 */
function episodeSources(latest: LatestEpisodeValues): ReaderEpisodeSource[] {
  const byTime = new Map<number, { readAt: string; episodes: number[] }>();
  for (const [episode, entry] of latest.pv) {
    const found = byTime.get(entry.time);
    if (found) {
      found.episodes.push(episode);
    } else {
      byTime.set(entry.time, { readAt: entry.readAt, episodes: [episode] });
    }
  }
  return [...byTime.entries()]
    .sort(([left], [right]) => right - left)
    .map(([, entry]) => ({
      readAt: entry.readAt,
      episodes: episodeRanges(entry.episodes),
    }));
}

/** [1,2,3,5] → 「第1〜3話、第5話」 */
export function episodeRanges(episodes: readonly number[]): string {
  const sorted = [...episodes].sort((left, right) => left - right);
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  const flush = () => {
    if (start === undefined) return;
    parts.push(
      start === previous ? `第${start}話` : `第${start}〜${previous}話`
    );
  };
  for (const episode of sorted.slice(1)) {
    if (episode === previous + 1) {
      previous = episode;
      continue;
    }
    flush();
    start = episode;
    previous = episode;
  }
  flush();
  return parts.join("、");
}

/** 3桁区切り（サイトの画面と同じ読み方） */
function count(value: number): string {
  return value.toLocaleString("ja-JP");
}

/**
 * 百分率を小数1桁で。**丸めは表示だけ**で、`value` は割り算の結果そのまま。
 */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
