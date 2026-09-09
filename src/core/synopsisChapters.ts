import type { EpisodeFile, WorkEntry } from "../models/types";
import type { Chapter } from "../models/chapter";
import { synopsisKey, type ChapterSynopsisSet } from "../models/synopsis";
import { formatChapterRange, groupEpisodesByChapter } from "./chapterGrouping";
import type { SynopsisChapterMark } from "./synopsisMarkdown";
import type { WorkFormatKey } from "./workFormat";
import { ChapterStore } from "./chapterStore";
import { readWorkFormat } from "./workFormatStore";
import { scanWork } from "./scanner";
import { logFailure } from "./logger";

/**
 * 各話あらすじの文書へ挟む「章の印」を作る（設計書6.66.4の3）。
 *
 * 章の台帳は**話のパス**で章を指し、あらすじは**話数とファイル名**で話を
 * 指す（`synopsisKey`）。この2つを突き合わせて、「どのあらすじの直前に
 * 章の見出しを置くか」を決めるのがここである。
 *
 * **束ね方は作品一覧・EPUBと同じ部品**（`groupEpisodesByChapter`）を通す。
 * ここで別に束ねると、一覧の章の切れ目と文書の切れ目がずれる。
 */

/**
 * 印を組み立てる（純粋関数）。
 *
 * - 台帳が空なら印も無い（文書はいままでどおり）
 * - 開始の話が見つからない章は**印を作らない**（一覧と同じ扱い。束ねる
 *   場所が決まらないものを、当て推量で挟まない）
 * - その章の話に**あらすじが1つも無ければ印を作らない**（中身の無い
 *   見出しだけが立つのを避ける。あらすじは話が増えるより先に古びる）
 */
export function buildSynopsisChapterMarks(
  set: ChapterSynopsisSet,
  episodes: readonly EpisodeFile[],
  chapters: readonly Chapter[],
  workFolder: string,
  format?: WorkFormatKey
): SynopsisChapterMark[] {
  if (chapters.length === 0) return [];

  const grouping = groupEpisodesByChapter(episodes, chapters, workFolder);
  const marks: SynopsisChapterMark[] = [];
  /**
   * ここより前のあらすじには、もう印を置かない。
   *
   * **文書の並びを戻さない**ための番人である。あらすじの並び（話数順）と
   * 話の並び（走査順）は、話数の読めない話が混ざると食い違いうる。
   */
  let cursor = 0;

  for (const group of grouping.groups) {
    if (group.missingStart) continue;

    // **合本（1ファイルに複数話）も同じ形で扱える。** 合本の中の話は
    // 同じファイル名を持つので、ファイル単位で章が決まる
    const files = new Set(group.episodes.map((episode) => episode.fileName));
    const index = set.episodes.findIndex(
      (entry, position) => position >= cursor && files.has(entry.fileName)
    );
    if (index < 0) continue;

    cursor = index + 1;
    const entry = set.episodes[index];
    marks.push({
      name: group.chapter.name,
      startKey: synopsisKey(entry.fileName, entry.chapter),
      range: formatChapterRange(group.episodes, format),
    });
  }

  return marks;
}

/**
 * 作品から印を読み込む。**どこで失敗しても印無し（従来の文書）へ倒す。**
 *
 * 章はあらすじの飾りであって、あらすじ本体より重くはない。台帳が壊れて
 * いる・走査できないというだけで文書が作れなくなるほうが困る
 * （作品一覧の「台帳が読めなくても話は出す」と同じ判断）。
 */
export async function loadSynopsisChapterMarks(
  work: WorkEntry,
  set: ChapterSynopsisSet
): Promise<SynopsisChapterMark[]> {
  if (set.episodes.length === 0) return [];

  let chapters: Chapter[];
  try {
    chapters = (await new ChapterStore(work).load()).chapters;
  } catch (error) {
    logFailure("あらすじの文書の章立て", {
      作品: work.title,
      内容: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  // 章の無い作品では走査もしない（読むだけとはいえ、全話を開く手間である）
  if (chapters.length === 0) return [];

  try {
    const scan = await scanWork(work);
    return buildSynopsisChapterMarks(
      set,
      scan.episodes,
      chapters,
      work.folderPath,
      await readWorkFormat(work)
    );
  } catch (error) {
    logFailure("あらすじの文書の章立て", {
      作品: work.title,
      内容: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
