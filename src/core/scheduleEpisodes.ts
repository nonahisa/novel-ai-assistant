import type { EpisodeFact } from "./schedulePlan";

/**
 * WEB連載の予定に使う「話ごとの事実」を組み立てる（設計書6.111.5）。
 *
 * - **書いたか**：走査した本文の話数（合本は範囲の全話）
 * - **投稿したか**：投稿状態の台帳（呼び出し側が `isPosted` を渡す。合本は話ごとに訊く）
 * - **予定の話**：単話プロットだけある話数（6.4.8）。本文が無いので「書いていない」、題だけ並べる
 *
 * 話数の読めない話（プロローグ・あとがき）は連載の予定の話数に当てられないので数えない。
 *
 * VS Code API には依存しない。
 */

export interface ScannedEpisodeLike {
  readonly chapterStart: number | null;
  readonly chapterEnd: number | null;
  /** 本文の純字数（合本はファイル全体） */
  readonly net: number;
  readonly title: string | null;
  /**
   * 投稿済みか。合本では話数を渡して訊く。単話のファイルは null（ファイルまるごと）
   */
  readonly isPosted: (chapter: number | null) => boolean;
}

export function buildEpisodeFacts(
  episodes: readonly ScannedEpisodeLike[],
  plannedTitles: ReadonlyMap<number, string | null>
): EpisodeFact[] {
  const facts = new Map<number, EpisodeFact>();
  for (const episode of episodes) {
    if (episode.chapterStart === null) continue;
    const end = episode.chapterEnd ?? episode.chapterStart;
    const span = Math.max(1, end - episode.chapterStart + 1);
    const collected = span > 1;
    for (let chapter = episode.chapterStart; chapter <= end; chapter++) {
      // 同じ話数が2つのファイルにあっても、先に見たほうを使う（走査の並びが正しい）
      if (facts.has(chapter)) continue;
      facts.set(chapter, {
        chapter,
        written: true,
        posted: episode.isPosted(collected ? chapter : null),
        // 合本の字数は話の数で均す（話ごとの字数は持っていない）
        chars: Math.round(episode.net / span),
        title: collected ? null : episode.title,
      });
    }
  }
  for (const [chapter, title] of plannedTitles) {
    if (facts.has(chapter)) continue;
    facts.set(chapter, { chapter, written: false, posted: false, chars: 0, title });
  }
  return [...facts.values()].sort((a, b) => a.chapter - b.chapter);
}
