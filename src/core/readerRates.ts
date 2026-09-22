import type { ReaderStatsRecord } from "../models/posting";

/**
 * 読者の反応から出す3つの率（作者の依頼、2026-09-23。約束 v1b）。
 *
 * - **離脱率** = 1 − 基準の話のPV ÷ 第1話のPV
 * - **ブックマーク率** = 作品全体のブックマーク ÷ 第1話のPV
 * - **評価率** = 作品全体のレビュー（評価した人数）÷ 第1話のPV
 *
 * **分母は第1話の読者**である（作者の訂正「ブックマーク率等は第一話読者
 * でした」、2026-09-23）。読みはじめた人のうち、何割がブックマーク・評価まで
 * 来たかを見る。
 *
 * **基準の話を使うのは離脱率だけ。** 基準の話は、最終更新（`updatedAt`）が
 * 読み取りの72時間以上前の話のうち、話数がいちばん大きい話である。更新した
 * 直後の話はまだ読まれ切っていないので、そこを使うと離脱率が実際より高く
 * 見える。ブックマーク率・評価率は更新日が無くても出せる。
 *
 * ## 数を作らない
 *
 * **材料からの割り算だけ**をする。見込み・補間・0埋めはしない。材料が
 * 1つでも欠ければ、その率は出さずに**欠けた理由**を返す——「0%」と出すと、
 * 読めなかったのか本当に0だったのか区別が付かない。
 *
 * ## 台帳には触らない
 *
 * 台帳は追記だけなので、同じ話が何度も入っている。**いちばん新しい取り込み
 * 1回ぶん**（話ごとの記録のうち、読み取り日時がいちばん新しいもの）だけで
 * 計算する。古い回を混ぜると、時点の違う数どうしを割ることになる。
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
   * その数を読み取った日時。**話ごとの取り込みと違う回の数を使ったときだけ**
   * 入る（作品全体の数が、話ごとと同じ回に無かったとき）。
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
  /** その話のPV。記録に無ければ undefined */
  pv?: number;
  updatedAt: string;
}

export interface ReaderRates {
  /**
   * 計算に使った話ごとの取り込みの日時。**話ごとの記録が1件も無ければ null**
   * （そのときは画面が節ごと出さない）。
   */
  episodeReadAt: string | null;
  base: ReaderRateBase | null;
  /** 基準の話を決められなかった理由 */
  baseMissing?: string;
  dropout: ReaderRate;
  bookmark: ReaderRate;
  rating: ReaderRate;
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
  const latest = latestEpisodeImport(records);

  // ---- 第1話のPV（3つの率すべての分母） ----
  const first = latest?.episodes.get(1);
  const firstPv: ReaderRateOperand | undefined =
    first?.metrics.pv !== undefined
      ? { label: "第1話のPV", value: first.metrics.pv }
      : undefined;
  const firstProblem = !latest
    ? "話ごとの記録がありません"
    : firstPv === undefined
      ? "第1話のPVがありません"
      : firstPv.value === 0
        ? "第1話のPVが0です（0では割れません）"
        : undefined;

  // ---- 基準の話（離脱率だけが使う） ----
  const baseResult = latest
    ? pickBaseEpisode(latest.episodes, latest.time)
    : { base: null, missing: "話ごとの記録がありません" };
  const base = baseResult.base;
  const basePv: ReaderRateOperand | undefined =
    base && base.pv !== undefined
      ? { label: `第${base.episode}話のPV`, value: base.pv }
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

  return {
    episodeReadAt: latest?.readAt ?? null,
    base,
    ...(baseResult.missing ? { baseMissing: baseResult.missing } : {}),
    dropout,
    bookmark: ratioRate(
      "bookmark",
      workMetric(records, "bookmarks", latest?.readAt),
      firstPv,
      firstProblem
    ),
    rating: ratioRate(
      "rating",
      workMetric(records, "reviews", latest?.readAt),
      firstPv,
      firstProblem
    ),
  };
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
function formulaOf(kind: RateKind, baseEpisode: number | undefined): string {
  if (kind === "dropout") {
    const base =
      baseEpisode === undefined ? "基準の話のPV" : `第${baseEpisode}話のPV`;
    return `1 − ${base} ÷ 第1話のPV`;
  }
  return `${WORK_LABELS[kind]} ÷ 第1話のPV`;
}

function missingRate(
  kind: RateKind,
  baseEpisode: number | undefined,
  operands: ReaderRateOperand[],
  missing: string
): ReaderRate {
  return {
    label: RATE_LABELS[kind],
    formula: formulaOf(kind, baseEpisode),
    operands,
    missing,
  };
}

function doneRate(
  kind: RateKind,
  baseEpisode: number | undefined,
  operands: ReaderRateOperand[],
  value: number,
  left: string
): ReaderRate {
  const percent = formatPercent(value);
  return {
    label: RATE_LABELS[kind],
    formula: formulaOf(kind, baseEpisode),
    value,
    percent,
    expression: `${left} = ${percent}`,
    operands,
  };
}

/** ブックマーク率・評価率（作品全体の数 ÷ 第1話のPV） */
function ratioRate(
  kind: "bookmark" | "rating",
  work: { value: number; readAt: string; sameImport: boolean } | undefined,
  firstPv: ReaderRateOperand | undefined,
  firstProblem: string | undefined
): ReaderRate {
  const workOperand: ReaderRateOperand | undefined = work
    ? {
        label: WORK_LABELS[kind],
        value: work.value,
        // 話ごとと違う回の数を使ったときだけ、いつの数かを添える
        ...(work.sameImport ? {} : { readAt: work.readAt }),
      }
    : undefined;
  const operands = [workOperand, firstPv].filter(isOperand);
  const problem =
    workOperand === undefined ? `${WORK_LABELS[kind]}がありません` : firstProblem;
  if (problem !== undefined || !workOperand || !firstPv) {
    return missingRate(kind, undefined, operands, problem ?? "材料が足りません");
  }
  return doneRate(
    kind,
    undefined,
    operands,
    workOperand.value / firstPv.value,
    `${count(workOperand.value)} ÷ ${count(firstPv.value)}`
  );
}

function isOperand(
  value: ReaderRateOperand | undefined
): value is ReaderRateOperand {
  return value !== undefined;
}

/**
 * 話ごとの記録（粒度なし）のうち、いちばん新しい取り込み1回ぶん。
 *
 * 1回の取り込みの中に同じ話が2件あれば、**あとから足したほう**を採る
 * （台帳は追記なので、あとにあるほうが新しい）。
 */
export function latestEpisodeImport(
  records: readonly ReaderStatsRecord[]
):
  | {
      readAt: string;
      time: number;
      episodes: Map<number, ReaderStatsRecord>;
    }
  | undefined {
  let newest: { readAt: string; time: number } | undefined;
  for (const record of records) {
    if (!isEpisodeSnapshot(record)) continue;
    const time = Date.parse(record.readAt);
    // 日時の読めない行（手で書き換えた跡）は、前後を決められないので使わない
    if (Number.isNaN(time)) continue;
    if (!newest || time > newest.time) {
      newest = { readAt: record.readAt, time };
    }
  }
  if (!newest) return undefined;

  const episodes = new Map<number, ReaderStatsRecord>();
  for (const record of records) {
    if (!isEpisodeSnapshot(record)) continue;
    if (Date.parse(record.readAt) !== newest.time) continue;
    // 話数の読めない行は、どの話か分からないので率にもグラフにも使えない
    if (record.episode === undefined) continue;
    episodes.set(record.episode, record);
  }
  return { ...newest, episodes };
}

function isEpisodeSnapshot(record: ReaderStatsRecord): boolean {
  return record.scope === "episode" && record.period === undefined;
}

/**
 * 基準の話を選ぶ。**更新から72時間以上たった話のうち、話数が最大のもの。**
 */
function pickBaseEpisode(
  episodes: ReadonlyMap<number, ReaderStatsRecord>,
  readTime: number
): { base: ReaderRateBase | null; missing?: string } {
  const settleMs = READER_RATE_SETTLE_HOURS * 60 * 60 * 1000;
  let sawUpdatedAt = false;
  let best: { episode: number; record: ReaderStatsRecord } | undefined;
  for (const [episode, record] of episodes) {
    if (record.updatedAt === undefined) continue;
    const updated = Date.parse(record.updatedAt);
    if (Number.isNaN(updated)) continue;
    sawUpdatedAt = true;
    if (readTime - updated < settleMs) continue;
    if (!best || episode > best.episode) best = { episode, record };
  }
  if (!best || best.record.updatedAt === undefined) {
    return {
      base: null,
      missing: sawUpdatedAt
        ? `更新から${READER_RATE_SETTLE_HOURS / 24}日以上たった話がありません`
        : "更新日の分かる話がありません",
    };
  }
  const pv = best.record.metrics.pv;
  return {
    base: {
      episode: best.episode,
      ...(pv === undefined ? {} : { pv }),
      updatedAt: best.record.updatedAt,
    },
  };
}

/**
 * 作品全体の数（その時点の値）。
 *
 * **話ごとと同じ回の取り込みにあれば、それを使う**（同じ時点の数どうしを
 * 割るため）。無ければ、その欄を持つ作品全体の記録のうち**いちばん新しい
 * もの**を使い、いつの数かを画面へ添える。
 */
function workMetric(
  records: readonly ReaderStatsRecord[],
  key: "bookmarks" | "reviews",
  episodeReadAt: string | undefined
): { value: number; readAt: string; sameImport: boolean } | undefined {
  const episodeTime =
    episodeReadAt === undefined ? Number.NaN : Date.parse(episodeReadAt);
  let same: { value: number; readAt: string } | undefined;
  let newest: { value: number; readAt: string; time: number } | undefined;
  for (const record of records) {
    if (record.scope !== "work" || record.period !== undefined) continue;
    const value = record.metrics[key];
    if (value === undefined) continue;
    const time = Date.parse(record.readAt);
    if (Number.isNaN(time)) continue;
    // 同じ日時に2件あれば、あとから足したほう
    if (time === episodeTime) same = { value, readAt: record.readAt };
    if (!newest || time >= newest.time) {
      newest = { value, readAt: record.readAt, time };
    }
  }
  if (same) return { ...same, sameImport: true };
  return newest
    ? { value: newest.value, readAt: newest.readAt, sameImport: false }
    : undefined;
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
