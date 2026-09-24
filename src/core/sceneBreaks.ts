/**
 * 1話の中の場面の区切り（2026-09-25、人称のよじれの2回目。設計書6.9.2）。
 *
 * 一人称の話の後半に「◆◇◆◇」を挟んで、宰相と国王の三人称の場面が続くことがある
 * （作者の作品、教科書チート127話）。話の単位で「語り手の一人称の話」と決めると、
 * 区切りの後の三人称の場面の名前まで「よじれ」として拾ってしまった。
 * **視点が移るのは、たいてい区切りのところ**なので、区切りごとに場面を分けて
 * 判定する。
 *
 * 区切りと見るのは、**字（漢字・かな・英数）を含まず、記号だけでできた行**のうち、
 *
 * - ◆◇■□●○◎☆★＊*※♢♦◈▼▽▲△ のどれかを含むもの（「◆◇◆◇」「＊＊＊」「◇」「***」）
 * - 線（―─━ー-－=＝~～〜）が3つ以上続くもの（「――――」「ーーーー」「---」）
 *
 * 作者の6作品の写しで数えた形（2026-09-25）：◆◇◆◇・◇◆◇◆ など52行、
 * 「ーーーー」「――――――」。**台詞だけの行（「……」「！？」）と「……」の行は
 * 区切りではない**（上の記号を含まず、線も続かない）。
 */

const BREAK_LINE =
  /^[\s　◆◇■□●○◎☆★＊*※♢♦◈▼▽▲△・･―─━ー\-－=＝~～〜]+$/u;
const BREAK_MARK = /[◆◇■□●○◎☆★＊*※♢♦◈▼▽▲△]/u;
const BREAK_RULE = /([―─━ー\-－=＝~～〜])\1{2,}/u;

/** その行が場面の区切りか */
export function isSceneBreakLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !BREAK_LINE.test(trimmed)) return false;
  return BREAK_MARK.test(trimmed) || BREAK_RULE.test(trimmed.replace(/[\s　]+/gu, ""));
}

/** 場面の行の範囲（0始まり、`end` は含まない）。区切りの行そのものはどの場面にも入れない */
export interface SceneRange {
  start: number;
  end: number;
}

/**
 * 行の並びを場面に割る。
 *
 * @param extraStarts 区切り行のほかに、場面が始まる行（まとめたチャンクの
 *   話の境目など）。話をまたいで1つの場面と数えないため
 */
export function sceneRanges(
  lines: readonly string[],
  extraStarts: Iterable<number> = []
): SceneRange[] {
  const starts = new Set<number>();
  for (const at of extraStarts) {
    if (at > 0 && at < lines.length) starts.add(at);
  }
  const ranges: SceneRange[] = [];
  let start = 0;
  for (let index = 0; index < lines.length; index++) {
    if (starts.has(index) && index > start) {
      ranges.push({ start, end: index });
      start = index;
    }
    if (isSceneBreakLine(lines[index])) {
      if (index > start) ranges.push({ start, end: index });
      start = index + 1;
    }
  }
  if (start < lines.length) ranges.push({ start, end: lines.length });
  return ranges;
}
