import {
  collectedEpisodeIndexAt,
  collectedEpisodeStarts,
  parseCollectedFile,
} from "./collectedFile";
import { episodePlotFileName } from "./resumeSheet";

/**
 * 単話プロットの並び（設計書6.36・6.4.8。作者の依頼、2026-09-23
 * 「プロットモードと単話プロットをうまくつないでくださいね」）。
 *
 * 3つを持つ。
 *
 * 1. **書いた話と予定の話を合わせた話数順**——単話プロットの「前の話・次の話」
 * 2. **予定の話の並べ替え・差し込みの計画**——動かすのは予定の話の単話
 *    プロットの話数（ファイル名）だけ。**本文のファイルには一切触れない。**
 *    本文のある話の話数を変えることになるなら、理由を返して止める
 * 3. **付け替えの実行**——一時名を通して衝突させず、途中で失敗したら元へ戻す
 *
 * VS Code APIに依存しない。ファイルを動かす口は呼ぶ側から渡す
 * （`applyRenumberPlan` と同じ作り。試験でファイルを作らずに順序と
 * 止まり方を確かめるため）。
 */

/** 本文のファイル1つの話数（合本は範囲） */
export interface EpisodeChapterSpan {
  chapterStart: number | null;
  chapterEnd?: number | null;
}

/** 並びの1つ */
export interface EpisodePlotOrderEntry {
  chapter: number;
  /** 本文が無く、単話プロットだけがある（予定の話） */
  planned: boolean;
}

/**
 * 本文のある話数。**合本は中の話を1つずつ数える**（第1〜10話の合本が
 * あるのに第5話を「空いている」と扱うと、同じ話が2つになる）。
 */
export function writtenChapterSet(
  episodes: readonly EpisodeChapterSpan[]
): Set<number> {
  const written = new Set<number>();
  for (const episode of episodes) {
    const start = episode.chapterStart;
    if (start === null) continue;
    const end = episode.chapterEnd ?? start;
    for (let chapter = start; chapter <= end; chapter++) written.add(chapter);
  }
  return written;
}

/**
 * 書いた話と予定の話を合わせた話数順（設計書6.36）。
 *
 * **話数の読めない話（「プロローグ.txt」）は並べない。** 単話プロットの
 * 置き場（`第N話.md`）を持てないので、前後へ移る先にならない。
 */
export function episodePlotOrder(
  episodes: readonly EpisodeChapterSpan[],
  plotChapters: Iterable<number>
): EpisodePlotOrderEntry[] {
  const written = writtenChapterSet(episodes);
  const all = new Set<number>([...written, ...plotChapters]);
  return [...all]
    .sort((left, right) => left - right)
    .map((chapter) => ({ chapter, planned: !written.has(chapter) }));
}

/**
 * 前・次の話数。端なら null。
 *
 * **いまの話数が並びに無くても答える**（飛んだ番号の単話プロットを開いて
 * いるときなど）——いちばん近い前後を返す。
 */
export function neighborEpisodeChapter(
  order: readonly EpisodePlotOrderEntry[],
  current: number,
  direction: "prev" | "next"
): number | null {
  if (direction === "next") {
    return order.find((entry) => entry.chapter > current)?.chapter ?? null;
  }
  for (let index = order.length - 1; index >= 0; index--) {
    if (order[index].chapter < current) return order[index].chapter;
  }
  return null;
}

/** 付け替え1件（話数で持つ。名前は `episodePlotFileName` が決める） */
export interface EpisodePlotRename {
  from: number;
  to: number;
}

export type PlannedEpisodeMovePlan =
  | { kind: "move"; renames: EpisodePlotRename[] }
  /** 動かせない。**理由を作者に見せる** */
  | { kind: "blocked"; reason: string }
  /** 動かしても何も変わらない（端・同じ話数） */
  | { kind: "noop"; reason: string };

/**
 * 本文のある話を動かすことになるときの断り。**なぜ止めるのかを言う**
 * ——言わないと「押しても効かない不具合」に見える。
 */
function writtenBlockReason(chapter: number): string {
  return (
    `第${chapter}話は本文があります。ここへ予定の話を入れるには、本文の話数の` +
    "振り直しになり、原稿のファイルに触れることになるため、ここでは動かしません" +
    "（本文の話数を変えるときは、話の差し込み・削除の操作を使ってください）。"
  );
}

/** 動かす話が予定の話か。違えば断りを返す */
function notPlannedReason(
  written: ReadonlySet<number>,
  plots: ReadonlySet<number>,
  chapter: number
): string | undefined {
  if (written.has(chapter)) {
    return `第${chapter}話は本文があります。並べ替えられるのは、本文のまだ無い予定の話だけです。`;
  }
  if (!plots.has(chapter)) {
    return `第${chapter}話の単話プロットが見つかりません。一覧を開き直してください。`;
  }
  return undefined;
}

/**
 * 予定の話を1つ上・下へ動かす（設計書6.4.8）。
 *
 * - 隣が予定の話 → **話数を入れ替える**（数の組は変わらない）
 * - 隣が本文のある話 → その向こう側に**空いた話数**があれば、そこへ移すだけ
 *   （本文は動かない）。空きが無ければ止める（本文の話数の振り直しになる）
 * - 端 → 何もしない
 */
export function planPlannedEpisodeStep(
  episodes: readonly EpisodeChapterSpan[],
  plotChapters: Iterable<number>,
  chapter: number,
  direction: "up" | "down"
): PlannedEpisodeMovePlan {
  const written = writtenChapterSet(episodes);
  const plots = new Set(plotChapters);
  const refused = notPlannedReason(written, plots, chapter);
  if (refused) return { kind: "blocked", reason: refused };

  const order = episodePlotOrder(episodes, plots);
  const at = order.findIndex((entry) => entry.chapter === chapter);
  const step = direction === "up" ? -1 : 1;
  const neighbor = order[at + step];
  if (!neighbor) {
    return {
      kind: "noop",
      reason:
        direction === "up"
          ? `第${chapter}話は、いちばん前にあります。`
          : `第${chapter}話は、いちばん後ろにあります。`,
    };
  }

  if (neighbor.planned) {
    return {
      kind: "move",
      renames: [
        { from: chapter, to: neighbor.chapter },
        { from: neighbor.chapter, to: chapter },
      ],
    };
  }

  // 隣は本文のある話。その向こうの空いた話数を探す（並びに無い番号＝空き）
  const beyond = order[at + step * 2]?.chapter;
  if (direction === "up") {
    const floor = beyond ?? 0;
    const free = neighbor.chapter - 1;
    if (free > floor && free >= 1) {
      return { kind: "move", renames: [{ from: chapter, to: free }] };
    }
  } else {
    const free = neighbor.chapter + 1;
    if (beyond === undefined || free < beyond) {
      return { kind: "move", renames: [{ from: chapter, to: free }] };
    }
  }
  return { kind: "blocked", reason: writtenBlockReason(neighbor.chapter) };
}

/**
 * 予定の話を、指定の話数へ差し込む（設計書6.4.8）。
 *
 * - 空いた話数 → 名前を変えるだけ
 * - 予定の話がいる話数 → その予定から先を1つずつずらし、**最初の空き**で止める
 *   （前へ動かすときは後ろへ、後ろへ動かすときは前へずらす）
 * - 本文のある話数、または**ずらす途中に本文のある話**が来る → 止める
 *   （本文のある話と話の間への差し込みは、本文の話数の振り直しになる）
 */
export function planPlannedEpisodeInsert(
  episodes: readonly EpisodeChapterSpan[],
  plotChapters: Iterable<number>,
  chapter: number,
  target: number
): PlannedEpisodeMovePlan {
  if (!Number.isSafeInteger(target) || target < 1) {
    return { kind: "blocked", reason: "話数は1以上の数字で入れてください。" };
  }
  const written = writtenChapterSet(episodes);
  const plots = new Set(plotChapters);
  const refused = notPlannedReason(written, plots, chapter);
  if (refused) return { kind: "blocked", reason: refused };
  if (target === chapter) {
    return { kind: "noop", reason: `第${chapter}話は、もうその話数にあります。` };
  }
  if (written.has(target)) {
    return { kind: "blocked", reason: writtenBlockReason(target) };
  }

  // 動かす話そのものは、もう空いたものとして見る（そこが最初の空きになりうる）
  const occupied = (value: number) =>
    value !== chapter && (plots.has(value) || written.has(value));
  if (!occupied(target)) {
    return { kind: "move", renames: [{ from: chapter, to: target }] };
  }

  const renames: EpisodePlotRename[] = [{ from: chapter, to: target }];
  const step = target < chapter ? 1 : -1;
  for (let value = target; occupied(value); value += step) {
    if (written.has(value)) {
      return { kind: "blocked", reason: writtenBlockReason(value) };
    }
    if (value + step < 1) {
      return { kind: "blocked", reason: "前へずらす話数がありません。" };
    }
    renames.push({ from: value, to: value + step });
  }
  return { kind: "move", renames };
}

/** 付け替えの途中で使う一時名の頭。`第N話.md` の形から外して一覧に出さない */
export const EPISODE_PLOT_MOVING_PREFIX = "並べ替え中_";

function movingName(chapter: number): string {
  return `${EPISODE_PLOT_MOVING_PREFIX}${episodePlotFileName(chapter)}`;
}

/** 置き場の中で名前を変える口。**上書きはしないこと**（既にあれば失敗させる） */
export interface EpisodePlotRenameOps {
  rename(fromName: string, toName: string): Promise<void>;
}

export type EpisodePlotRenameOutcome =
  | { ok: true; renames: EpisodePlotRename[] }
  | {
      ok: false;
      /** 失敗した一歩（作者に見せる） */
      failedStep: string;
      detail: string;
      /** 元の名前へすべて戻せたか */
      rolledBack: boolean;
      /** 戻せなかったもの。**いまどの名前で残っているか**を言う */
      stranded: Array<{ now: string; original: string }>;
    };

/**
 * 付け替えを実行する（設計書6.4.8）。
 *
 * **2段で動かす。** まず動かすものを全部一時名へ退け、それから新しい名前へ
 * 置く。入れ替え（3→4、4→3）を1段でやると、先に動かしたほうが相手の名前に
 * 乗り上げる。上書きは許さない（口の側で `overwrite: false`）。
 *
 * **途中で失敗したら、済んだ手を逆順に戻す。** 戻すのにも失敗したものは
 * 「いまの名前 → 元の名前」を返して、作者が手で直せるようにする
 * （黙って半端なまま終えない）。中身には一切触らない——名前だけである。
 */
export async function applyEpisodePlotRenames(
  renames: readonly EpisodePlotRename[],
  ops: EpisodePlotRenameOps
): Promise<EpisodePlotRenameOutcome> {
  const done: Array<{ from: string; to: string; original: string }> = [];
  const steps = [
    ...renames.map((entry) => ({
      from: episodePlotFileName(entry.from),
      to: movingName(entry.from),
      original: episodePlotFileName(entry.from),
    })),
    ...renames.map((entry) => ({
      from: movingName(entry.from),
      to: episodePlotFileName(entry.to),
      original: episodePlotFileName(entry.from),
    })),
  ];

  for (const step of steps) {
    try {
      await ops.rename(step.from, step.to);
      done.push(step);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const stranded: Array<{ now: string; original: string }> = [];
      // 逆順に戻す。**1つ戻せなくても残りは試す**（戻せる分は戻す）
      for (const undo of [...done].reverse()) {
        try {
          await ops.rename(undo.to, undo.from);
        } catch {
          stranded.push({ now: undo.to, original: undo.original });
        }
      }
      return {
        ok: false,
        failedStep: `${step.from} → ${step.to}`,
        detail,
        rolledBack: stranded.length === 0,
        stranded,
      };
    }
  }
  return { ok: true, renames: [...renames] };
}

/**
 * 原稿のその行が何話か（原稿エディタから単話プロットを開くとき。設計書6.25）。
 *
 * **合本のときだけ答える**（それ以外は undefined——ファイルの話数で決める）。
 * いま居る話の決め方は `collectedEpisodeIndexAt` の1か所を通す（「次の話」や
 * 投稿用コピーと同じ。写しを作ると、見えている話と開く単話プロットがずれる）。
 * 話数の読めない話なら null。
 */
export function chapterAtManuscriptLine(
  rawText: string,
  line: number
): number | null | undefined {
  const starts = collectedEpisodeStarts(rawText);
  if (starts.length < 2) return undefined;
  const episodes = parseCollectedFile(rawText);
  if (!episodes) return undefined;
  const order = starts[collectedEpisodeIndexAt(starts, line)].order;
  return episodes.find((episode) => episode.order === order)?.chapter ?? null;
}
