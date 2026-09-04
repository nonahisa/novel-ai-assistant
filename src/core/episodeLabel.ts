import type { EpisodeFile } from "../models/types";
import { toHalfWidthDigits } from "./episodeParser";
import type { WorkFormatKey } from "./workFormat";

/**
 * 話の見出しの作り方。
 *
 * 作品一覧（`views/workTree.ts`）と話ごとの文字数一覧
 * （`core/episodeCharTable.ts`）の両方が使う。2か所に同じ規則を書くと、
 * 片方だけ直したときに同じ話が別の名前で並ぶことになる。
 */

/**
 * 数えるものの呼び方（設計書6.4.5）。
 *
 * **SNS記事は「話」ではない。** 同じアカウントの投稿を並べたもので、
 * 続きものではない。「第3話」と出すと、読み手にも書き手にも
 * 連なった物語に見える。
 *
 * 形式が決まっていない作品では今までどおり「話」にする。
 * **「決めていない」を「SNS記事ではない」と読み替えない**ための既定ではなく、
 * これまでの振る舞いを変えないための既定である。
 */
export interface EpisodeUnit {
  /** 1件の呼び方。「話」「投稿」 */
  noun: string;
  /** 通し番号の見出しを作る */
  label: (from: number, to?: number) => string;
}

const CHAPTER_UNIT: EpisodeUnit = {
  noun: "話",
  label: (from, to) =>
    to !== undefined && to !== from ? `第${from}〜${to}話` : `第${from}話`,
};

const POST_UNIT: EpisodeUnit = {
  noun: "投稿",
  // 「第3投稿」とは言わない。数えるものが違えば言い方も違う
  label: (from, to) =>
    to !== undefined && to !== from ? `投稿${from}〜${to}` : `投稿${from}`,
};

/**
 * 創作メモ集の単位（設計書6.70）。
 *
 * **メモは続きものではない。** SNS記事と同じ側の扱いで、
 * 「第3話」ではなく「メモ3」と数える。番号を持たないメモのほうが
 * 多いので、この見出しが出るのは番号付きのファイルだけになる。
 */
const MEMO_UNIT: EpisodeUnit = {
  noun: "メモ",
  label: (from, to) =>
    to !== undefined && to !== from ? `メモ${from}〜${to}` : `メモ${from}`,
};

export function episodeUnit(format?: WorkFormatKey): EpisodeUnit {
  if (format === "sns") return POST_UNIT;
  if (format === "memo") return MEMO_UNIT;
  // 脚本は「第◯話＝1回ぶんの台本」なので、小説と同じ数え方のまま
  return CHAPTER_UNIT;
}

/**
 * 一覧の見出しに出す文字（設計書6.70）。
 *
 * 番号が読めた話は、その見出し（「第3話」「メモ3」）をそのまま使う。
 * 読めなかったときに何を出すかがタイプで変わる。
 *
 * - **創作メモ集**：番号が無いのは普通のこと。題名（拡張子を落とした
 *   ファイル名）をそのまま見出しにする
 * - **それ以外**：番号が読めないのは不備なので、ファイル名を拡張子ごと
 *   出す。直すときの手掛かりになる
 */
export function episodeListLabel(
  ep: Pick<EpisodeFile, "fileName">,
  chapterLabel: string,
  format?: WorkFormatKey
): string {
  if (chapterLabel) return chapterLabel;
  if (format !== "memo") return ep.fileName;
  return ep.fileName.replace(/\.[^.]+$/, "") || ep.fileName;
}

/**
 * 「第3話」「投稿3」「プロローグ」のような見出し。
 * 話数が読み取れない本編には何も返さない（想像で番号を振らない）。
 */
export function formatChapterLabel(
  ep: Pick<
    EpisodeFile,
    "kind" | "chapterStart" | "chapterEnd" | "date" | "dateSeq"
  >,
  format?: WorkFormatKey
): string {
  // 日付で名付けられたファイルは、日付そのものが見出しになる。
  // **同じ日に何本も書ける**ので、2本目以降は並びの数字を添える
  if (ep.date) {
    return ep.dateSeq ? `${ep.date}（${ep.dateSeq}）` : ep.date;
  }
  if (ep.kind !== "本編" && ep.kind !== "不明") {
    // プロローグ・幕間などは種別を見出しにする
    return ep.chapterStart !== null ? `${ep.kind}${ep.chapterStart}` : ep.kind;
  }
  if (ep.chapterStart === null) return "";
  return episodeUnit(format).label(
    ep.chapterStart,
    ep.chapterEnd ?? undefined
  );
}

/**
 * 一覧に出すタイトル。話数の重複を落とす。
 *
 * 投稿サイトからDLしたファイルのヘッダーには「第1話 気がついたら幽霊に」と、
 * **話数を含んだ形**でタイトルが入っている。見出し側にも「第1話」を出すので、
 * そのまま並べると「第1話　第1話 気がついたら幽霊に」と二重になる。
 *
 * タイトルが話数だけの場合（「第16話」）は何も返さない。
 * 見出しと同じ文字を右にもう一度出しても、作者に伝わる情報が増えないためである。
 */
export function episodeTitle(
  ep: Pick<EpisodeFile, "metaTitle" | "subtitle">,
  chapterLabel: string
): string | null {
  return stripChapterLabel((ep.metaTitle ?? ep.subtitle)?.trim(), chapterLabel);
}

/**
 * 見出しと重なる部分を、題から落とす。
 *
 * **見出しを付ける側は、必ずここを通すこと。**
 * 通し忘れると「第1話　第1話　気がついたら幽霊」になる。
 * 各話あらすじの見出しで実際に起きた（2026-08-19、作者が実機で発見）。
 *
 * 題が話数だけの場合（「第16話」）は何も返さない。
 * 見出しと同じ文字を右にもう一度出しても、伝わる情報が増えない。
 *
 * **全角数字・ゼロ埋めの違いも同じ話数として見る**（設計書6.65.15）。
 * 投稿サイトのDLは題に「第001話」（ゼロ埋め）や「第１話」（全角）の形で
 * 話数を持つことがあり、章ラベル（「第1話」）とは文字列として一致しない。
 * EPUBの目次で「第1話　第001話　◯◯」と二重に出た（作者の報告、
 * 2026-09-03）。単純な `startsWith` では見逃すので、数字の並びだけを
 * 値として比べる。
 */
export function stripChapterLabel(
  title: string | null | undefined,
  chapterLabel: string
): string | null {
  const raw = title?.trim();
  if (!raw) return null;
  if (!chapterLabel) return raw;

  const matchLength = duplicatedPrefixLength(raw, chapterLabel);
  if (matchLength === null) return raw;

  // 「第1話」に続く区切り（空白・記号）も一緒に落とす
  const rest = raw.slice(matchLength).replace(/^[\s　:：・．.。、,，\-–—]+/, "");
  return rest.length > 0 ? rest : null;
}

/**
 * `raw` の先頭が `chapterLabel` と同じ話数を指しているか。
 *
 * 一致すれば `raw` 側での一致した長さ（全角・ゼロ埋めで `chapterLabel` と
 * 文字数が違いうる）を返す。指していなければ null。
 *
 * まず `chapterLabel` の中の数字の並びを `[0-9０-９]+` に置き換えた
 * 正規表現を作り、`raw` の先頭がその形と合うかを見る。合っていても
 * **数字の値（全角→半角・ゼロ埋めを外して比較）が違えば別の話数**なので
 * 一致とはしない——「第1話」で「第12話から始まる題」を誤って剥がさない
 * ため。
 */
function duplicatedPrefixLength(
  raw: string,
  chapterLabel: string
): number | null {
  const pattern = chapterLabelPattern(chapterLabel);
  const matched = pattern.exec(raw);
  if (!matched) return null;

  const rawNumbers = numbersOf(matched[0]);
  const labelNumbers = numbersOf(chapterLabel);
  if (rawNumbers.length !== labelNumbers.length) return null;
  if (!rawNumbers.every((value, index) => value === labelNumbers[index])) {
    return null;
  }
  return matched[0].length;
}

/** 数字の並びを、全角→半角・先頭のゼロ埋めを外した形で取り出す */
function numbersOf(value: string): string[] {
  return (value.match(/[0-9０-９]+/g) ?? []).map((run) => {
    const half = toHalfWidthDigits(run).replace(/^0+(?=\d)/, "");
    return half;
  });
}

/**
 * `chapterLabel` の数字の並びを、桁数を問わない形へ組み替えた正規表現。
 *
 * `第1話` → `/^第[0-9０-９]+話/`。数字以外の文字（全角括弧を含む）は
 * そのまま残す——`chapterLabel` は `formatChapterLabel` が作るので、
 * 正規表現の特殊文字が混ざるのは半角の記号（日付の `-` など）だけである。
 */
function chapterLabelPattern(chapterLabel: string): RegExp {
  const escaped = chapterLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withWildcard = escaped.replace(/[0-9０-９]+/g, "[0-9０-９]+");
  return new RegExp(`^${withWildcard}`);
}

/**
 * 本（EPUB）に出す1話の見出し（設計書6.65）。
 *
 * **書き出しとエディター画面のプレビューが同じものを使う。** 別々に
 * 組み立てると、プレビューで見た見出しと本の見出しが食い違う。
 * 話数と題が二重に並ばないよう、`episodeTitle` を必ず通す。
 */
export function bookHeading(
  ep: Pick<
    EpisodeFile,
    | "kind"
    | "chapterStart"
    | "chapterEnd"
    | "date"
    | "dateSeq"
    | "metaTitle"
    | "subtitle"
    | "fileName"
  >,
  format?: WorkFormatKey
): string {
  const chapter = formatChapterLabel(ep, format);
  const title = episodeTitle(ep, chapter);
  return [chapter, title].filter(Boolean).join("　") || ep.fileName;
}

/**
 * 目次を章ごとに区切るときの、束ねの名前（設計書6.65.6）。
 *
 * **章の情報は、この作品のどこにも無い。** ファイル名から読み取れるのは
 * 話数と種別（プロローグ・幕間・エピローグ）だけなので、そこまでで
 * 束ねる。読み取れないものは空文字を返し、**章を捏造しない**——
 * 作者が書いていない構成が本に載るのがいちばん困る。
 *
 * 日付で名付けられたSNS記事は月でまとめる。続きものではないので
 * 「第N話」の並びより、月のほうが読み手の探し方に近い（設計書6.4.6）。
 */
export function episodeGroupLabel(
  ep: Pick<EpisodeFile, "kind" | "chapterStart" | "date">
): string {
  if (ep.date) {
    const matched = /^(\d{4})-(\d{2})/.exec(ep.date);
    if (matched) return `${matched[1]}年${Number(matched[2])}月`;
    return "";
  }
  if (ep.kind !== "本編" && ep.kind !== "不明") return ep.kind;
  // 話数が読み取れた本編だけを「本編」でまとめる。番号も種別も
  // 分からないものは、どこへ入れるべきか決められない
  return ep.chapterStart !== null ? "本編" : "";
}

/**
 * 合本（1ファイルに複数話）と見なす最小の話数。
 *
 * **1話しか入っていないものを合本とは呼ばない。** 投稿サイトの
 * ダウンロードには、1話ずつ別ファイルなのに区切り行
 * （`------- エピソードN開始 -------`）が入っている形がある。
 * `parseCollectedFile` は区切り行が1つでもあれば話に分けて返すので、
 * 「1話ぶん」という印が全ファイルに付いていた（2026-08-21、作者が実機で気づいた）。
 *
 * 印の目的は「巨大な1話に見えてしまう」のを防ぐことなので、
 * **2話以上のときにだけ意味がある。**
 */
export const MIN_COLLECTED_EPISODES = 2;

/** その話は合本として扱うか。**作品一覧と執筆統計で同じ判定を使う** */
export function isCollectedFile(
  collectedCount: number | null | undefined
): boolean {
  return (collectedCount ?? 0) >= MIN_COLLECTED_EPISODES;
}
