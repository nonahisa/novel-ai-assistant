import type { EpisodeFile } from "../models/types";

/**
 * 話の見出しの作り方。
 *
 * 作品一覧（`views/workTree.ts`）と話ごとの文字数一覧
 * （`core/episodeCharTable.ts`）の両方が使う。2か所に同じ規則を書くと、
 * 片方だけ直したときに同じ話が別の名前で並ぶことになる。
 */

/**
 * 「第3話」「プロローグ」のような話数の見出し。
 * 話数が読み取れない本編には何も返さない（想像で番号を振らない）。
 */
export function formatChapterLabel(
  ep: Pick<EpisodeFile, "kind" | "chapterStart" | "chapterEnd">
): string {
  if (ep.kind !== "本編" && ep.kind !== "不明") {
    // プロローグ・幕間などは種別を見出しにする
    return ep.chapterStart !== null ? `${ep.kind}${ep.chapterStart}` : ep.kind;
  }
  if (ep.chapterStart === null) return "";
  if (ep.chapterEnd !== null && ep.chapterEnd !== ep.chapterStart) {
    return `第${ep.chapterStart}〜${ep.chapterEnd}話`;
  }
  return `第${ep.chapterStart}話`;
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
