import type { EpisodeFile } from "../models/types";
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

export function episodeUnit(format?: WorkFormatKey): EpisodeUnit {
  return format === "sns" ? POST_UNIT : CHAPTER_UNIT;
}

/**
 * 「第3話」「投稿3」「プロローグ」のような見出し。
 * 話数が読み取れない本編には何も返さない（想像で番号を振らない）。
 */
export function formatChapterLabel(
  ep: Pick<EpisodeFile, "kind" | "chapterStart" | "chapterEnd">,
  format?: WorkFormatKey
): string {
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
  const raw = (ep.metaTitle ?? ep.subtitle)?.trim();
  if (!raw) return null;
  if (!chapterLabel || !raw.startsWith(chapterLabel)) return raw;
  // 「第1話」に続く区切り（空白・記号）も一緒に落とす
  const rest = raw
    .slice(chapterLabel.length)
    .replace(/^[\s　:：・．.。、,，\-–—]+/, "");
  return rest.length > 0 ? rest : null;
}
