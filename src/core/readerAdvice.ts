import {
  POSTING_SITES,
  postingSiteInfo,
  type PostingLedger,
  type PostingSiteId,
  type ReaderStatsRecord,
} from "../models/posting";
import {
  computeReaderRates,
  formatPercent,
  latestEpisodeValues,
  type ReaderRate,
  type ReaderRateBase,
  type ReaderRates,
} from "./readerRates";

/**
 * 読者の反応の助言の**材料**（残課題 B9。設計書6.79.7.3）。
 *
 * ## 決め打ちの助言をやめた（作者の方針転換、2026-09-23 朝）
 *
 * 0.75.16 では、作者の記事の目安だけでコードが決め打ちの文を出していた。
 * 作者の言葉：
 *
 * - 「これはむしろ例示だけでAIには自由に答えてほしい」
 * - 「話数が増える、長期休載などあれば離脱率も上がるのではないかと思います。
 *   その場合はアップの日付などから判断し、休載前の最終話で測ったものを出す
 *   など、**一律作者のやる気を削ぐことは避けてください**」
 *
 * 50話で約70%という目安は「50話で」の値で、200話を超える作品や、長く休んだ
 * あとの作品に同じ物差しを当てると、作品の実力と関係なく「目安より高い」と
 * 言うことになる。決め打ちの文は作品の事情を読めない。
 *
 * そこで**分担を変えた**：
 *
 * - **数はコードが正確に作る**（ここ）。率・話ごとのPV・休載らしい区間・
 *   休載前の最終話での離脱率——どれも台帳からの割り算で、見込みは作らない
 * - **読むのはAI**（`prompts/readerAdvice.ts`。P-40）。記事の目安は
 *   「こういう見方もある」という例示として渡し、判定の基準にはさせない
 *
 * 材料は、執筆量パネルのボタンと相談パネルの**両方が同じものを使う**
 * （二重に持たない）。
 *
 * VS Code API には依存しない。
 */

/** 例示として渡す記事1本 */
export interface ReaderAdviceSource {
  /** 題と日付（「「…」（note、2025-06-15）」） */
  label: string;
  url: string;
}

/**
 * 例示の出どころ。**番号は拾い出しの md と同じ**（①③⑥）。
 *
 * 画面では題と日付で出す——「作者の記事①」と書いても、Marketplace から入れた
 * 人には誰の何番か分からない。③は拾い出しに題が無いので、場所と日付で呼ぶ
 * （題を推測で書かない）。
 */
export const READER_ADVICE_SOURCES = {
  article1: {
    label: "「WEB小説再入門10【物言わぬ読者の可視化手法】」（note、2025-06-15）",
    url: "https://note.com/project_hisa/n/n7cfe5c39dd4b",
  },
  article3: {
    label: "creative-story.net の記事（2022-09-08）",
    url: "https://creative-story.net/narou_hisa2/",
  },
  article6: {
    label: "「『小説家になろう』における読者獲得法 その1」（note、2021-02-16）",
    url: "https://note.com/project_hisa/n/n5f1b0f39542f",
  },
} as const satisfies Record<string, ReaderAdviceSource>;

/**
 * 記事にある目安。**判定には使わない**——AIへ例示として渡す文を組む材料
 * （`prompts/readerAdvice.ts`）で、数字を2か所に書かないためにここに置く。
 */
export const READER_ADVICE_BENCHMARKS = {
  /** 離脱率100%：作品として成立していない（①） */
  dropoutBroken: 1,
  /** 50話で離脱率約70%：WEB小説として中堅（①） */
  dropoutMidTier: 0.7,
  /** 中堅の目安が何話時点の値か（①） */
  dropoutMidTierEpisode: 50,
  /** 離脱率約50%：書籍化レベル（①） */
  dropoutPublishable: 0.5,
  /** 最高値は離脱率2%程度（きわめて稀な例。①） */
  dropoutBest: 0.02,
  /** 1話→2話で8割以上の離脱：文章の基礎的な課題（③） */
  openingFirstStep: 0.8,
  /** 序盤全体で7割以上の離脱：序盤のインパクト不足・タイトルと内容の食い違い（③） */
  openingWhole: 0.7,
  /** 評価率が3割を超えればランキングを駆け上がれる（①） */
  ratingClimb: 0.3,
  /** 改稿で読破率が10%→35%に戻った実例（③。【普遍】の経験則） */
  revisionRecoveredFrom: 0.1,
  revisionRecoveredTo: 0.35,
} as const;

/** 急に減った話を、大きい順に何話まで材料へ入れるか */
export const READER_ADVICE_MAX_DROPS = 5;

/**
 * 話ごとのPVを**全部**渡す上限の話数。これを超えたら要約する。
 *
 * 219話ぶんを全部並べると、それだけで数千字になり、AIは数の羅列に
 * 引きずられる。60話までなら1行ずつ並べても2,000字ほどで、全体を見渡せる。
 */
export const READER_ADVICE_FULL_SERIES_MAX = 60;

/**
 * 休載の見分けのしきい値（設計書6.79.7.3）。**記事には無い**ので、
 * **作品自身のふだんの間隔と比べる**形にした。
 *
 * - ふだんの間隔の**4倍**以上空いた所：週1回の作品なら4週（更新が3回続けて
 *   抜けた）、月1回の作品なら4か月。1回・2回の抜けは、事情で遅れた程度で
 *   休載とは言いにくい
 * - ただし**28日（4週）未満は休載と呼ばない**：毎日更新の作品が1週間
 *   休んだのは、作者の言う「長期休載」ではない
 */
export const HIATUS_USUAL_MULTIPLIER = 4;
export const HIATUS_MIN_DAYS = 28;
/**
 * ふだんの間隔を決めるのに要る、更新と更新の間の数。
 * 3つ以下では、たまたまの間隔と区別が付かない。
 */
export const HIATUS_MIN_INTERVALS = 4;
/**
 * 同じ回の更新とみなす近さ。まとめて何話か出した日は、1回の更新である
 * （話と話の間を数えると、ふだんの間隔が0日になってしまう）。
 */
export const SAME_UPDATE_HOURS = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 大きく減った話1つ */
export interface ReaderAdviceDrop {
  episode: number;
  pv: number;
  /** 比べた相手＝それまでにいちばんPVが少なかった話 */
  fromEpisode: number;
  fromPv: number;
  /** 減った割合（0.33 なら 33%） */
  ratio: number;
  percent: string;
}

/** 「第1話の読者のうち、第N話までに何割が離れたか」 */
export interface ReaderRatioFact {
  episode: number;
  pv: number;
  firstPv: number;
  /** 1 − pv ÷ firstPv */
  ratio: number;
  percent: string;
}

/** 話ごとのPV1点 */
export interface ReaderPvPoint {
  episode: number;
  pv: number;
  /** 第1話のPVに対する割合（第1話のPVが無ければ undefined） */
  retainedPercent?: string;
}

/** 休載らしい区間1つ */
export interface ReaderHiatusGap {
  /** 休む前の最後の話 */
  beforeEpisode: number;
  /** 休んだあとの最初の話 */
  afterEpisode: number;
  /** 休む前の最後の更新（推定。ISO） */
  from: string;
  /** 休んだあとの最初の更新（推定。ISO） */
  to: string;
  days: number;
  /** 休む前の最終話での離脱率（1 − その話のPV ÷ 第1話のPV） */
  dropoutBefore?: ReaderRatioFact;
  pvBefore?: number;
  pvAfter?: number;
}

/**
 * 休載の見分けの結果。
 *
 * - `found`：休載らしい区間がある
 * - `none`：ふだんの間隔が分かり、休載らしい区間は無い
 * - `unknown`：更新日が無い・少ないので見分けられない（`reason`）
 */
export interface ReaderHiatusReport {
  status: "found" | "none" | "unknown";
  reason?: string;
  /** ふだんの間隔（日。更新と更新の間の中央値） */
  usualDays?: number;
  /** 休載と見たしきい値（日） */
  thresholdDays?: number;
  gaps: ReaderHiatusGap[];
  /**
   * 最後の更新から、読んだ時点までの日数が、しきい値を超えているとき。
   * **完結か休載かは材料からは分からない**ので、そうとだけ言う。
   */
  stalled?: { lastEpisode: number; lastUpdate: string; days: number };
}

export interface ReaderAdviceMaterial {
  /** 「カクヨム」 */
  siteLabel: string;
  /** 話ごとの記録のうち、いちばん新しい取り込み。無ければ null */
  readAt: string | null;
  dropout: ReaderRate;
  bookmark: ReaderRate;
  rating: ReaderRate;
  base: ReaderRateBase | null;
  baseMissing?: string;
  /** 作品の長さ */
  length: {
    /** PVの分かる話の数 */
    episodes: number;
    /** いちばん大きい話数 */
    lastEpisode: number;
    /** 最初の話の公開（推定）と、最後の話の更新。更新日が無ければ無い */
    firstUpdate?: string;
    lastUpdate?: string;
    /** その間の日数 */
    spanDays?: number;
  };
  /** 記録にある話数（昇順）。**AIの答えに出る話数の照合に使う** */
  existingEpisodes: number[];
  firstPv?: number;
  /** 話ごとのPV。多ければ要約した点だけ（`summarized`） */
  pvPoints: ReaderPvPoint[];
  summarized: boolean;
  /** 1話→2話で離れた割合 */
  firstStep?: ReaderRatioFact;
  /** 第1話の読者の7割以上が初めて離れた話（見た範囲の中で） */
  seventyPercentAt?: ReaderRatioFact;
  /** 急に読者が減った話（大きい順） */
  drops: ReaderAdviceDrop[];
  /** 序盤・減り方を見た範囲の最後の話 */
  inspectedUntil?: number;
  /** 第50話時点の離脱率（中堅の目安が「50話で」の値なので） */
  at50?: ReaderRatioFact;
  hiatus: ReaderHiatusReport;
  /** 材料の限界（AIへも画面へも、そのまま渡す） */
  notes: string[];
}

/**
 * 材料を組む。
 *
 * @param rates `computeReaderRates` の結果（同じ記録から出したもの）
 * @param records **1つのサイトの**記録。**台帳に書かれた順**で渡す
 *   （率・グラフと同じ拾い方をするため）
 */
export function buildReaderAdviceMaterial(
  siteLabel: string,
  rates: ReaderRates,
  records: readonly ReaderStatsRecord[]
): ReaderAdviceMaterial {
  const latest = latestEpisodeValues(records);
  const pvs = new Map<number, number>();
  for (const [episode, entry] of latest.pv) pvs.set(episode, entry.value);

  const existing = [
    ...new Set([...latest.pv.keys(), ...latest.updated.keys()]),
  ].sort((left, right) => left - right);
  const pvEpisodes = [...pvs.keys()].sort((left, right) => left - right);
  const lastEpisode = existing[existing.length - 1] ?? 0;

  const firstPvValue = pvs.get(1);
  const firstPv =
    firstPvValue !== undefined && firstPvValue > 0 ? firstPvValue : undefined;
  const ratioAt = (episode: number): ReaderRatioFact | undefined => {
    const pv = pvs.get(episode);
    if (pv === undefined || firstPv === undefined) return undefined;
    const ratio = 1 - pv / firstPv;
    return { episode, pv, firstPv, ratio, percent: formatPercent(ratio) };
  };

  const notes: string[] = [];
  const hiatus = detectHiatus(latest.updated, pvs, ratioAt);
  const publishTimes = estimatedPublishTimes(latest.updated);

  /*
    **見る範囲は基準の話まで。** それより新しい話はまだ読まれ切っていない
    ので、PVが少なく出る（離脱が大きく見える）。基準の話が決まらない
    （更新日が無い）ときは最後の話まで見るが、そう断る——黙って混ぜると、
    新しい話の少なさを「減った」と読ませることになる。
  */
  const inspectedUntil = rates.base?.episode ?? pvEpisodes[pvEpisodes.length - 1];
  if (!rates.base && pvEpisodes.length > 0) {
    notes.push(
      "更新から3日以上たった話が分からない（基準の話が決まらない）ので、" +
        "新しい話ほどまだ読まれ切っておらず、PVが少なく出ている可能性があります。"
    );
  }

  const firstStep =
    pvEpisodes.includes(2) && (inspectedUntil ?? 0) >= 2 ? ratioAt(2) : undefined;
  let seventyPercentAt: ReaderRatioFact | undefined;
  if (inspectedUntil !== undefined) {
    for (const episode of pvEpisodes) {
      if (episode < 2 || episode > inspectedUntil) continue;
      const fact = ratioAt(episode);
      if (fact && fact.ratio >= READER_ADVICE_BENCHMARKS.openingWhole) {
        seventyPercentAt = fact;
        break;
      }
    }
  }
  const drops =
    inspectedUntil !== undefined ? findDrops(pvs, inspectedUntil) : [];

  // 第50話時点。**50話より先がある作品だけ**（50話ちょうどの作品では
  // 離脱率そのものと同じ値になる）
  const midTier = READER_ADVICE_BENCHMARKS.dropoutMidTierEpisode;
  const at50 = lastEpisode > midTier ? ratioAt(midTier) : undefined;

  const firstTime = publishTimes.get(existing.find((e) => publishTimes.has(e)) ?? -1);
  const lastUpdated = latest.updated.get(lastEpisode);
  const length: ReaderAdviceMaterial["length"] = {
    episodes: pvEpisodes.length,
    lastEpisode,
  };
  if (firstTime !== undefined && lastUpdated) {
    length.firstUpdate = new Date(firstTime).toISOString();
    length.lastUpdate = lastUpdated.updatedAt;
    length.spanDays = Math.max(
      0,
      Math.round((lastUpdated.updatedTime - firstTime) / DAY_MS)
    );
  }
  if (latest.updated.size > 0) {
    notes.push(
      "話ごとの日付は、サイトの「最終更新」の日時で、公開日ではありません。" +
        "あとから直した話は新しい日付になります。そのため「その話より後の話の、" +
        "いちばん早い更新日までには公開されていた」と読んで間隔を出しています。" +
        "途中から後ろの話をまとめて直していると、休載でない所が休載らしく見えることがあります。"
    );
  }

  const pvPoints = pickPvPoints(pvEpisodes, pvs, firstPv, {
    base: rates.base?.episode,
    drops,
    hiatus,
    firstStep,
    seventyPercentAt,
  });

  return {
    siteLabel,
    readAt: rates.episodeReadAt,
    dropout: rates.dropout,
    bookmark: rates.bookmark,
    rating: rates.rating,
    base: rates.base,
    ...(rates.baseMissing ? { baseMissing: rates.baseMissing } : {}),
    length,
    existingEpisodes: existing,
    ...(firstPv !== undefined ? { firstPv } : {}),
    pvPoints: pvPoints.points,
    summarized: pvPoints.summarized,
    ...(firstStep ? { firstStep } : {}),
    ...(seventyPercentAt ? { seventyPercentAt } : {}),
    drops,
    ...(inspectedUntil !== undefined ? { inspectedUntil } : {}),
    ...(at50 ? { at50 } : {}),
    hiatus,
    notes,
  };
}

/**
 * 台帳から、サイトごとの材料を組む。**執筆統計のボタンと相談の両方がここを通る**
 * （材料の作り方を二重に持たない）。
 *
 * 話ごとの記録が無いサイトは入れない（率も休載も出せない）。並びは
 * `POSTING_SITES` に揃える（画面の並びと同じ）。
 *
 * @param site 1つのサイトだけが要るとき（執筆統計のボタンはサイトごとにある）
 */
export function buildReaderAdviceMaterials(
  ledger: PostingLedger,
  site?: PostingSiteId
): ReaderAdviceMaterial[] {
  const materials: ReaderAdviceMaterial[] = [];
  for (const info of POSTING_SITES) {
    if (site !== undefined && info.id !== site) continue;
    // **台帳に書かれた順**で渡す（同じ日時に同じ話が2件あれば、あとのほう）
    const records = (ledger.readerStats ?? []).filter(
      (entry) => entry.site === info.id
    );
    const rates = computeReaderRates(records);
    if (rates.episodeReadAt === null) continue;
    materials.push(
      buildReaderAdviceMaterial(postingSiteInfo(info.id).label, rates, records)
    );
  }
  return materials;
}

/**
 * 話ごとの「遅くともこの時までには公開されていた」時刻。
 *
 * **更新日は最終編集の日時で、公開日ではない**（貼り込み係が読むのは
 * カクヨムの「◯年◯月◯日 最終更新」の枡）。あとから直した古い話は新しい
 * 日付を持つので、そのまま並べると、直した話の前に大きな空きが出て
 * 休載に見える。
 *
 * 第k話は、第k話より後のどの話よりも先に公開されている。後の話の更新日は
 * その話の公開より後なので、**第k話以降の更新日のいちばん早いもの**までには、
 * 第k話は公開されていた。直した話の日付はこれで押さえ込まれる
 * （休載を見逃す向きには倒れても、作り出す向きには倒れにくい）。
 */
function estimatedPublishTimes(
  updated: ReadonlyMap<number, { updatedTime: number }>
): Map<number, number> {
  const episodes = [...updated.keys()].sort((left, right) => right - left);
  const result = new Map<number, number>();
  let earliest = Number.POSITIVE_INFINITY;
  for (const episode of episodes) {
    const time = updated.get(episode)?.updatedTime;
    if (time === undefined) continue;
    earliest = Math.min(earliest, time);
    result.set(episode, earliest);
  }
  return result;
}

/**
 * 休載らしい区間を見つける（作者の依頼、2026-09-23）。
 *
 * 更新（同じ回にまとめて出した話は1回と数える）と更新の間の日数を並べ、
 * その**中央値を「ふだんの間隔」**にする。平均でないのは、休載の空き
 * そのものが平均を引き上げ、見分けたいものが物差しを歪めるから。
 */
export function detectHiatus(
  updated: ReadonlyMap<
    number,
    { updatedAt: string; updatedTime: number; readAt: string; time: number }
  >,
  pvs: ReadonlyMap<number, number>,
  ratioAt: (episode: number) => ReaderRatioFact | undefined
): ReaderHiatusReport {
  if (updated.size === 0) {
    return {
      status: "unknown",
      reason: "話ごとの更新日が記録に無いので、休載を見分けられません",
      gaps: [],
    };
  }
  const times = estimatedPublishTimes(updated);
  const episodes = [...times.keys()].sort((left, right) => left - right);

  // 同じ回の更新をまとめる
  const updates: Array<{ first: number; last: number; start: number; end: number }> = [];
  for (const episode of episodes) {
    const time = times.get(episode) as number;
    const current = updates[updates.length - 1];
    if (current && time - current.end < SAME_UPDATE_HOURS * 60 * 60 * 1000) {
      current.last = episode;
      current.end = time;
    } else {
      updates.push({ first: episode, last: episode, start: time, end: time });
    }
  }

  const intervals: Array<{ days: number; before: (typeof updates)[number]; after: (typeof updates)[number] }> = [];
  for (let index = 1; index < updates.length; index++) {
    const before = updates[index - 1];
    const after = updates[index];
    intervals.push({ days: (after.start - before.end) / DAY_MS, before, after });
  }
  if (intervals.length < HIATUS_MIN_INTERVALS) {
    return {
      status: "unknown",
      reason:
        `更新日の分かる更新が${updates.length}回しかなく、ふだんの間隔が分かりません` +
        `（${HIATUS_MIN_INTERVALS + 1}回以上要ります）`,
      gaps: [],
    };
  }

  const usualDays = median(intervals.map((interval) => interval.days));
  const thresholdDays = Math.max(
    usualDays * HIATUS_USUAL_MULTIPLIER,
    HIATUS_MIN_DAYS
  );

  const gaps: ReaderHiatusGap[] = intervals
    .filter((interval) => interval.days >= thresholdDays)
    .map((interval) => {
      const beforeEpisode = interval.before.last;
      const afterEpisode = interval.after.first;
      // 第1話の前には読者がいない。休む前が第1話なら離脱率は 0% で意味が無い
      const dropoutBefore = beforeEpisode >= 2 ? ratioAt(beforeEpisode) : undefined;
      const pvBefore = pvs.get(beforeEpisode);
      const pvAfter = pvs.get(afterEpisode);
      return {
        beforeEpisode,
        afterEpisode,
        from: new Date(interval.before.end).toISOString(),
        to: new Date(interval.after.start).toISOString(),
        days: roundDays(interval.days),
        ...(dropoutBefore ? { dropoutBefore } : {}),
        ...(pvBefore !== undefined ? { pvBefore } : {}),
        ...(pvAfter !== undefined ? { pvAfter } : {}),
      };
    });

  /*
    **いま止まっているか。** 最後の話の更新から、それを読んだ時点までの
    日数で見る（手元の時計では見ない——同じ台帳から、機械によって違う
    答えが出ないように）。完結したのか休んでいるのかは材料に無い。
  */
  const lastEpisode = episodes[episodes.length - 1];
  const lastEntry = updated.get(lastEpisode);
  let stalled: ReaderHiatusReport["stalled"];
  if (lastEntry) {
    const days = (lastEntry.time - lastEntry.updatedTime) / DAY_MS;
    if (days >= thresholdDays) {
      stalled = {
        lastEpisode,
        lastUpdate: lastEntry.updatedAt,
        days: roundDays(days),
      };
    }
  }

  return {
    status: gaps.length > 0 ? "found" : "none",
    usualDays: roundDays(usualDays),
    thresholdDays: roundDays(thresholdDays),
    gaps,
    ...(stalled ? { stalled } : {}),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 日数は小数1桁まで（「6.9日」）。半日単位の違いは判断を変えない */
function roundDays(days: number): number {
  return Math.round(days * 10) / 10;
}

/**
 * 話ごとのPVを、AIへ渡す点に絞る。
 *
 * **60話までは全部渡す。** それより長い作品は、序盤の細かい点（1・2・3・5・
 * 10・20・30・40・50話）と、そこから50話おき、それに「何かが起きた話」
 * （基準の話・急に減った話とその比べた相手・休載の前後・7割を越えた話・
 * 最後の話）だけを渡す。**点を作らない**——どれも記録にある値そのもの。
 */
function pickPvPoints(
  pvEpisodes: readonly number[],
  pvs: ReadonlyMap<number, number>,
  firstPv: number | undefined,
  marks: {
    base?: number;
    drops: readonly ReaderAdviceDrop[];
    hiatus: ReaderHiatusReport;
    firstStep?: ReaderRatioFact;
    seventyPercentAt?: ReaderRatioFact;
  }
): { points: ReaderPvPoint[]; summarized: boolean } {
  const toPoint = (episode: number): ReaderPvPoint => {
    const pv = pvs.get(episode) as number;
    return {
      episode,
      pv,
      ...(firstPv !== undefined
        ? { retainedPercent: formatPercent(pv / firstPv) }
        : {}),
    };
  };
  if (pvEpisodes.length <= READER_ADVICE_FULL_SERIES_MAX) {
    return { points: pvEpisodes.map(toPoint), summarized: false };
  }
  const wanted = new Set<number>([1, 2, 3, 5, 10, 20, 30, 40, 50]);
  const last = pvEpisodes[pvEpisodes.length - 1];
  for (let episode = 100; episode <= last; episode += 50) wanted.add(episode);
  wanted.add(last);
  if (marks.base !== undefined) wanted.add(marks.base);
  for (const drop of marks.drops) {
    wanted.add(drop.episode);
    wanted.add(drop.fromEpisode);
  }
  for (const gap of marks.hiatus.gaps) {
    wanted.add(gap.beforeEpisode);
    wanted.add(gap.afterEpisode);
  }
  if (marks.seventyPercentAt) wanted.add(marks.seventyPercentAt.episode);
  return {
    points: pvEpisodes.filter((episode) => wanted.has(episode)).map(toPoint),
    summarized: true,
  };
}

/**
 * 急に読者が減っている話を探す（⑥「話数毎に分析して急激に読者が減っている
 * 話は何か対策する」）。
 *
 * **比べる相手は「前の話」ではなく「それまでにいちばん少なかった話」。**
 * 実物（教科書チート）では第54・55話や第188話だけPVが跳ねていて、前の話と
 * 比べると、跳ねの直後の話が「急に減った」ように見えた。跳ねは宣伝などで
 * 外から入った読者で、続けて読んできた読者の数ではない——続けて読む人は
 * 前の話を読んでいるので、それまでの最少を上回らないのが本来の形である。
 *
 * 第2話から数えはじめる（1話→2話は `firstStep` が持つ）。基準の話より新しい
 * 話は、まだ読まれ切っていないので見ない。**減り幅に下限は設けない**
 * （記事に無い）——大きい順に `READER_ADVICE_MAX_DROPS` 話まで。
 */
export function findDrops(
  pvs: ReadonlyMap<number, number>,
  untilEpisode: number
): ReaderAdviceDrop[] {
  const episodes = [...pvs.keys()]
    .filter((episode) => episode >= 2 && episode <= untilEpisode)
    .sort((left, right) => left - right);
  const drops: ReaderAdviceDrop[] = [];
  let lowest: { episode: number; pv: number } | undefined;
  for (const episode of episodes) {
    const pv = pvs.get(episode);
    if (pv === undefined) continue;
    if (!lowest) {
      lowest = { episode, pv };
      continue;
    }
    if (pv < lowest.pv) {
      // lowest.pv は pv より大きいので 0 ではない
      const ratio = 1 - pv / lowest.pv;
      drops.push({
        episode,
        pv,
        fromEpisode: lowest.episode,
        fromPv: lowest.pv,
        ratio,
        percent: formatPercent(ratio),
      });
      lowest = { episode, pv };
    }
  }
  return drops
    .sort((left, right) => right.ratio - left.ratio || left.episode - right.episode)
    .slice(0, READER_ADVICE_MAX_DROPS);
}
