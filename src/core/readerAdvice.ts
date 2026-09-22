import type { ReaderStatsRecord } from "../models/posting";
import {
  formatPercent,
  latestEpisodeValues,
  type ReaderRates,
} from "./readerRates";

/**
 * 読者の反応の助言（残課題 B9。作者の依頼、2026-09-23。設計書6.79.7.3）。
 *
 * 作者「あとで助言を行えるようにしてください」「なろうとかだと更新の話とかは
 * 古い情報もあるので気を付けてください」。
 *
 * ## 助言の元は作者の記事だけ
 *
 * 目安の数字は `docs/読者の反応の助言_作者の考え.md` に拾い出した記事にある
 * ものだけを使う。**記事に無いしきい値は作らない**——作ると、作者の考えでは
 * ない基準が作者の名前で出ることになる。だから次のものは**出さない**。
 *
 * - ブックマーク率の目安と助言（記事に無い）
 * - 評価率が低いときの対策（記事に無い。目安を超えたときに「伸びている」とだけ言う）
 * - 【古い可能性】に分けた事柄（なろうの更新時刻・トップページ・完結欄など。
 *   サイトの仕組みが変わっていれば、作者の考えとして誤ったことを言う）
 *
 * ## 助言はコードで決める
 *
 * AIに書かせない。率の値と話ごとのPVを、記事の目安と比べるだけである。
 * 同じ数からはいつも同じ助言が出るので、どの目安で何を言ったかを後から
 * 確かめられる。
 *
 * ## 言い方はまだタイプに依らない
 *
 * 作者の記事⑦（2026-09-23）は「数字の目安は記事から、言い方は作者のタイプ
 * （相談の助言方針、6.86）から」としている。ここはまず**中立の文面だけ**を
 * 持つ——11タイプぶんの言い方を推測で書き分けると、作者の考えでない文面が
 * 作者の考えとして出る。
 *
 * VS Code API には依存しない。
 */

/** 助言の出どころ（記事1本） */
export interface ReaderAdviceSource {
  /** 題と日付（「「…」（note、2025-06-15）」） */
  label: string;
  url: string;
}

/**
 * 出どころの記事。**番号は拾い出しの md と同じ**（①③⑥）。
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
 * 記事にある目安。**ここに無い数字で判定しない。**
 *
 * 境目の含み方は記事の言い方に合わせた——「8割以上」「7割以上」は含む、
 * 「3割を超えれば」は含まない。離脱率の「約70%」「約50%」は、その値ちょうどを
 * 目安の内側に数える（ちょうどで「高い」と言わない）。
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
  /** 1話→2話で8割以上の離脱：文章の基礎的な課題（③） */
  openingFirstStep: 0.8,
  /** 序盤全体で7割以上の離脱：序盤のインパクト不足・タイトルと内容の食い違い（③） */
  openingWhole: 0.7,
  /** 評価率が3割を超えればランキングを駆け上がれる（①） */
  ratingClimb: 0.3,
} as const;

/** 指す話の数（大きく減った順に） */
export const READER_ADVICE_MAX_DROPS = 3;

export type ReaderAdviceTopic =
  | "dropout"
  | "openingFirst"
  | "openingWhole"
  | "decline"
  | "rating"
  | "bookmark";

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

export interface ReaderAdviceItem {
  topic: ReaderAdviceTopic;
  /** 「離脱率」「序盤（1話→2話）」 */
  title: string;
  /** 目安と比べてどうか */
  text: string;
  /** 指した話（話ごとの減り方だけ）。無ければ空 */
  drops: ReaderAdviceDrop[];
  /** 記事が挙げている手。**記事に手が無ければ空**（作らない） */
  suggestions: string[];
  sources: ReaderAdviceSource[];
}

/** 出さなかった助言の理由・数字の読み方の注意 */
export interface ReaderAdviceNote {
  topic?: ReaderAdviceTopic;
  text: string;
  sources: ReaderAdviceSource[];
}

export interface ReaderAdvice {
  items: ReaderAdviceItem[];
  /** 出さなかった助言と、その理由（材料が欠けた・記事に目安が無い） */
  withheld: ReaderAdviceNote[];
  /** 数字の読み方の注意（記事の【普遍】のもの）。いつも付ける */
  cautions: ReaderAdviceNote[];
}

const { article1, article3, article6 } = READER_ADVICE_SOURCES;
const B = READER_ADVICE_BENCHMARKS;

/**
 * 数字の読み方の注意。**拾い出しで【普遍】に分けたものだけ。**
 *
 * 更新直後の話へのリンクの話は「原則は普遍、トップページという呼び方は
 * サイト次第」とされているので、原則だけを書く。
 */
const CAUTIONS: ReaderAdviceNote[] = [
  {
    text:
      "話数が少ないうちは、離脱率が安定しません。読み切った人の割合をきちんと計れるのは、安定期の終わりごろからです。",
    sources: [article3],
  },
  {
    text: "PVは厳密な人数ではなく、人気のおおよその目安です。ほかの話や前の回と比べて読みます。",
    sources: [article1],
  },
  {
    text:
      "更新した話へ直接リンクして宣伝すると、その話から読みはじめる人が出て、話ごとの数が歪みます。宣伝のリンクは、各話ではなく作品の各話一覧へ向けます。",
    sources: [article1, article3],
  },
  {
    text:
      "10万字を超える長編は、読むのに何日もかかります。1日だけでなく、何日かに分けて集計したほうが確かです。",
    sources: [article3],
  },
];

/**
 * 率と話ごとのPVから、記事の目安に沿った助言を組む。
 *
 * @param rates `computeReaderRates` の結果（同じ記録から出したもの）
 * @param records **1つのサイトの**記録。**台帳に書かれた順**で渡す
 *   （率・グラフと同じ拾い方をするため）
 */
export function buildReaderAdvice(
  rates: ReaderRates,
  records: readonly ReaderStatsRecord[]
): ReaderAdvice {
  const items: ReaderAdviceItem[] = [];
  const withheld: ReaderAdviceNote[] = [];

  const pvs = new Map<number, number>();
  for (const [episode, entry] of latestEpisodeValues(records).pv) {
    pvs.set(episode, entry.value);
  }

  // ---- 離脱率・序盤・話ごとの減り方（どれも「読まれ切った話」が要る） ----
  const dropout = rates.dropout;
  const base = rates.base;
  const firstPv = pvs.get(1);
  if (dropout.value === undefined || !base || firstPv === undefined) {
    withheld.push({
      topic: "dropout",
      text:
        "離脱率が出ていないので、離脱率・序盤の離れ方・話ごとの減り方の助言は出しません（" +
        (dropout.missing ?? rates.baseMissing ?? "材料が足りません") +
        "）。",
      sources: [],
    });
  } else if (base.episode < 2) {
    // 第1話しか読まれ切っていない。離脱率は 0% と出るが、離れ方は
    // まだ見えていないだけで、書籍化レベルと読んではいけない
    withheld.push({
      topic: "dropout",
      text:
        "更新から3日以上たった話が第1話だけなので、読者の離れ方はまだ見られません。離脱率の助言は出しません。",
      sources: [],
    });
  } else {
    const value = dropout.value;
    items.push(dropoutItem(value, base.episode, pvs, firstPv));

    const opening = openingItems(pvs, firstPv, base.episode);
    items.push(...opening);

    // 目安（書籍化レベル＝約50%）を上回ったら、どの話で減っているかを指す（⑥）
    if (value > B.dropoutPublishable) {
      const drops = findDrops(pvs, base.episode);
      if (drops.length > 0) items.push(declineItem(drops, base.episode));
    }
  }

  // ---- 評価率（目安を超えたときだけ言う） ----
  const rating = rates.rating;
  if (rating.value === undefined || rating.percent === undefined) {
    withheld.push({
      topic: "rating",
      text:
        "評価率が出ていないので、評価率の助言は出しません（" +
        (rating.missing ?? "材料が足りません") +
        "）。",
      sources: [],
    });
  } else if (rating.value > B.ratingClimb) {
    items.push({
      topic: "rating",
      title: "評価率",
      text:
        `評価率 ${rating.percent} は、目安の「3割を超えれば、ランキングを駆け上がれる」を超えています。伸びている作品です。`,
      drops: [],
      suggestions: [],
      sources: [article1],
    });
  } else {
    withheld.push({
      topic: "rating",
      text:
        `評価率 ${rating.percent} は、目安の「3割を超えれば、ランキングを駆け上がれる」には届いていません。低いときの対策は記事に無いので、助言は出しません。`,
      sources: [article1],
    });
  }

  // ---- ブックマーク率（記事に目安が無い） ----
  withheld.push({
    topic: "bookmark",
    text: "ブックマーク率は、記事に目安が無いので、数値を見せるだけにして助言は出しません。",
    sources: [],
  });

  return { items, withheld, cautions: CAUTIONS };
}

function dropoutItem(
  value: number,
  baseEpisode: number,
  pvs: ReadonlyMap<number, number>,
  firstPv: number
): ReaderAdviceItem {
  const percent = formatPercent(value);
  let text: string;
  if (value >= B.dropoutBroken) {
    text = `離脱率 ${percent} は、目安で「作品として成立していない」とされる100%です。`;
  } else {
    if (value > B.dropoutMidTier) {
      text = `離脱率 ${percent} は、目安（50話で約70%なら中堅、約50%なら書籍化レベル）より高い値です。`;
    } else if (value > B.dropoutPublishable) {
      text = `離脱率 ${percent} は、目安の中堅（50話で約70%）と書籍化レベル（約50%）のあいだです。`;
    } else {
      text = `離脱率 ${percent} は、目安の書籍化レベル（約50%）に届いています。`;
    }
    text += midTierNote(baseEpisode, pvs, firstPv);
  }
  return {
    topic: "dropout",
    title: "離脱率",
    text,
    drops: [],
    suggestions: [],
    sources: [article1],
  };
}

/**
 * 中堅の目安は「50話で」の値である。基準の話が50話でないときに、黙って
 * 比べると、長い作品ほど高く見える。
 *
 * **第50話時点の値は、率と同じ式で出すだけ**（新しい目安は作らない）。
 * 基準の話が50話より先なら、第50話も読まれ切っている。
 */
function midTierNote(
  baseEpisode: number,
  pvs: ReadonlyMap<number, number>,
  firstPv: number
): string {
  const at = B.dropoutMidTierEpisode;
  if (baseEpisode === at) return "";
  if (baseEpisode < at) {
    return `中堅の目安は50話時点の値で、この作品の基準の話（第${baseEpisode}話）はまだ50話まで来ていません。`;
  }
  const pv = pvs.get(at);
  if (pv === undefined) return "中堅の目安は50話時点の値です。";
  return (
    `中堅の目安は50話時点の値です。この作品の第50話時点では ` +
    `${formatPercent(1 - pv / firstPv)}（1 − ${count(pv)} ÷ ${count(firstPv)}）です。`
  );
}

/**
 * 序盤（③）。**1話→2話の壊滅的な脱落と、序盤全体の脱落を分ける。**
 *
 * - 1話→2話で8割以上 → 基礎から見直して書き直す（③の強い助言。ここだけ）
 * - 序盤全体で7割以上 → 序盤のインパクト不足・タイトルと内容の食い違いを疑う
 *
 * **序盤が何話までかは記事に無い。** 決めつけずに、第1話の読者の7割が
 * 初めて離れた話を示し、そこまでが序盤かどうかは作者に委ねる。
 *
 * どちらも**第1話まで来た読者が離れた割合**で、第1話へ来る読者の数（流入）の
 * 多い少ないとは別の問題である（③も分けて扱う）。
 */
function openingItems(
  pvs: ReadonlyMap<number, number>,
  firstPv: number,
  baseEpisode: number
): ReaderAdviceItem[] {
  const items: ReaderAdviceItem[] = [];
  const inflowNote =
    "これは第1話まで来た読者が離れた割合で、第1話へ来る読者の数（流入）の多い少ないとは別の問題です。";

  const secondPv = pvs.get(2);
  let firstStepFired = false;
  if (secondPv !== undefined && baseEpisode >= 2) {
    const ratio = 1 - secondPv / firstPv;
    if (ratio >= B.openingFirstStep) {
      firstStepFired = true;
      items.push({
        topic: "openingFirst",
        title: "序盤（1話→2話）",
        text:
          `第1話の読者のうち ${formatPercent(ratio)} が、第2話までに離れています（1 − ${count(secondPv)} ÷ ${count(firstPv)}）。` +
          "目安では、1話から2話で8割以上が離れるのは、文章の基礎に課題があるしるしとされています。" +
          inflowNote,
        drops: [],
        suggestions: [
          "記事では、基礎から見直したうえで、この作品を1から書き直すことを勧めています。",
        ],
        sources: [article3],
      });
    }
  }

  // 第1話の読者の7割が、初めて離れた話（基準の話まで）
  const episodes = [...pvs.keys()]
    .filter((episode) => episode >= 2 && episode <= baseEpisode)
    .sort((left, right) => left - right);
  for (const episode of episodes) {
    const pv = pvs.get(episode);
    if (pv === undefined) continue;
    const ratio = 1 - pv / firstPv;
    if (ratio < B.openingWhole) continue;
    // 第2話で越えていて、1話→2話の助言をもう出したなら、同じことを2度言わない
    if (episode === 2 && firstStepFired) break;
    items.push({
      topic: "openingWhole",
      title: "序盤全体",
      text:
        `第1話の読者の7割以上が、第${episode}話までに離れています（1 − ${count(pv)} ÷ ${count(firstPv)} = ${formatPercent(ratio)}）。` +
        `目安では、序盤全体で7割以上が離れるときは、序盤のインパクト不足や、タイトルと内容の食い違いを疑うところです。序盤が何話までかは記事に無いので、第${episode}話までがこの作品の序盤にあたるかどうかは、作者が判断してください。` +
        inflowNote,
      drops: [],
      suggestions: [
        "序盤の場面に、読み進めたくなる引き（インパクト）があるか見直す",
        "タイトル・あらすじと、序盤の中身が食い違っていないか確かめる",
      ],
      sources: [article3],
    });
    break;
  }
  return items;
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
 * 第2話から数えはじめる（1話→2話は序盤の助言が見る）。基準の話より新しい
 * 話は、まだ読まれ切っていないので見ない。**減り幅に下限は設けない**
 * （記事に無い）——大きい順に `READER_ADVICE_MAX_DROPS` 話まで。
 */
export function findDrops(
  pvs: ReadonlyMap<number, number>,
  baseEpisode: number
): ReaderAdviceDrop[] {
  const episodes = [...pvs.keys()]
    .filter((episode) => episode >= 2 && episode <= baseEpisode)
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

/**
 * 話ごとの減り方。**選択肢は③の「安定期の読者減少」への手だけ**
 * （再推敲・再校正・話の切れ目の調整・細かい改稿）。基礎からの書き直しは
 * 1話→2話の壊滅的な脱落専用なので、ここでは言わない。
 */
function declineItem(
  drops: ReaderAdviceDrop[],
  baseEpisode: number
): ReaderAdviceItem {
  return {
    topic: "decline",
    title: "話ごとの減り方",
    text:
      `離脱率が書籍化レベルの目安を上回っているので、急に読者が減っている話を探しました。それまでにいちばんPVが少なかった話から、さらに大きく減った話です（基準の第${baseEpisode}話まで）。`,
    drops,
    suggestions: [
      "読み返して推敲・校正し、表現を平易にする",
      "話の切れ目（どこで話を区切るか）を調整する",
      "細かく改稿する",
    ],
    sources: [article6, article3],
  };
}

/** 3桁区切り（率の式と同じ読み方） */
function count(value: number): string {
  return value.toLocaleString("ja-JP");
}
