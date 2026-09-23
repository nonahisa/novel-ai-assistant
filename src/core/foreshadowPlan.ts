import type { Foreshadow } from "../models/foreshadow";

/**
 * 伏線を話の並びへ重ねる（設計書6.35・6.4.8。作者の依頼、2026-09-23
 * 「伏線とも連携させてください」）。
 *
 * プロットモードの一覧に「張った／回収した／回収予定」の数を出し、
 * 単話プロットを開くときに「この話で張った・回収予定の伏線」を知らせる。
 * **数えるのはここだけ**にする——一覧と知らせで数え方がずれると、
 * 「一覧では1件なのに、知らせでは0件」が起きる。
 *
 * VS Code APIに依存しない（台帳を読むのも画面に出すのも呼ぶ側）。
 */

/** 1話ぶんの数。0 は画面に出さない（呼ぶ側が落とす） */
export interface ForeshadowChapterCounts {
  /** この話で張った伏線（状態によらない） */
  planted: number;
  /** この話で回収した伏線（回収済みのもの） */
  resolved: number;
  /**
   * この話で回収する予定の伏線。**未回収のものだけ**——回収済みなら
   * 「回収した」のほうに出ており、意図して開けたままのものは予定が無い
   */
  planned: number;
}

export const ZERO_FORESHADOW_COUNTS: ForeshadowChapterCounts = {
  planted: 0,
  resolved: 0,
  planned: 0,
};

/**
 * 話数ごとの数。**話数不明のものはどの話にも数えない**（推測で埋めない）。
 */
export function foreshadowCountsByChapter(
  records: readonly Foreshadow[]
): Map<number, ForeshadowChapterCounts> {
  const counts = new Map<number, ForeshadowChapterCounts>();
  const bump = (chapter: number | null, key: keyof ForeshadowChapterCounts) => {
    if (chapter === null) return;
    const entry = counts.get(chapter) ?? { ...ZERO_FORESHADOW_COUNTS };
    entry[key] += 1;
    counts.set(chapter, entry);
  };
  for (const record of records) {
    bump(record.plantedChapter, "planted");
    if (record.status === "resolved") bump(record.resolvedChapter, "resolved");
    if (record.status === "open") bump(record.plannedResolveChapter, "planned");
  }
  return counts;
}

/**
 * 話数の範囲の数を足す。**合本の1行**（第1〜10話）は中の話を足し合わせる
 * ——最後の話数だけで数えると、合本の前半で張った伏線が一覧から消える。
 */
export function sumForeshadowCounts(
  counts: ReadonlyMap<number, ForeshadowChapterCounts>,
  from: number,
  to: number
): ForeshadowChapterCounts {
  const total = { ...ZERO_FORESHADOW_COUNTS };
  for (let chapter = from; chapter <= to; chapter++) {
    const entry = counts.get(chapter);
    if (!entry) continue;
    total.planted += entry.planted;
    total.resolved += entry.resolved;
    total.planned += entry.planned;
  }
  return total;
}

/**
 * 書いた最後の話数。合本は終わりの話数まで見る。本文が無ければ null。
 */
export function lastWrittenChapter(
  episodes: ReadonlyArray<{ chapterStart: number | null; chapterEnd?: number | null }>
): number | null {
  let last: number | null = null;
  for (const episode of episodes) {
    const end = episode.chapterEnd ?? episode.chapterStart;
    if (end !== null && (last === null || end > last)) last = end;
  }
  return last;
}

/**
 * 回収予定を過ぎても未回収の伏線（設計書6.35）。
 *
 * **予定の話そのものは、まだ過ぎていない**（予定の話数 < 書いた最後の話数）。
 * 予定の話を書いている最中に「過ぎた」と言うと、これから回収するところを
 * 急かすことになる。未回収（`open`）だけを見る——意図して開けたままのものは
 * 回収しないと決めてある。
 */
export function overdueForeshadows(
  records: readonly Foreshadow[],
  lastChapter: number | null
): Foreshadow[] {
  if (lastChapter === null) return [];
  return records.filter(
    (record) =>
      record.status === "open" &&
      record.plannedResolveChapter !== null &&
      record.plannedResolveChapter < lastChapter
  );
}

/** その話で気にかける伏線（未回収のものだけ） */
export interface ForeshadowChapterNotice {
  /** この話で張った、まだ回収していない伏線 */
  planted: Foreshadow[];
  /** この話で回収する予定の、まだ回収していない伏線 */
  plannedResolve: Foreshadow[];
}

/**
 * その話の単話プロットを開くときに添える伏線（設計書6.35・6.36）。
 *
 * **未回収のものだけ。** 回収済みのものを並べても、書く手がかりにならない。
 */
export function foreshadowNoticeForChapter(
  records: readonly Foreshadow[],
  chapter: number
): ForeshadowChapterNotice {
  const open = records.filter((record) => record.status === "open");
  return {
    planted: open.filter((record) => record.plantedChapter === chapter),
    plannedResolve: open.filter(
      (record) => record.plannedResolveChapter === chapter
    ),
  };
}

/** 知らせに並べる名前の数。多いと知らせが読めなくなる */
const NOTICE_NAME_LIMIT = 3;

/**
 * 知らせの1文。**何も無ければ null**（知らせを出さない）。
 *
 * 名前は数件だけ並べ、残りは件数で言う（全部は伏線の一覧にある）。
 */
export function describeForeshadowNotice(
  label: string,
  notice: ForeshadowChapterNotice
): string | null {
  const parts: string[] = [];
  if (notice.planted.length > 0) {
    parts.push(`張った伏線 ${notice.planted.length}件（${names(notice.planted)}）`);
  }
  if (notice.plannedResolve.length > 0) {
    parts.push(
      `回収予定の伏線 ${notice.plannedResolve.length}件（${names(notice.plannedResolve)}）`
    );
  }
  if (parts.length === 0) return null;
  return `${label}：${parts.join("／")}。どれもまだ回収していません。`;
}

function names(records: readonly Foreshadow[]): string {
  const shown = records.slice(0, NOTICE_NAME_LIMIT).map((record) => record.label);
  const rest = records.length - shown.length;
  return rest > 0 ? `${shown.join("、")} ほか${rest}件` : shown.join("、");
}
