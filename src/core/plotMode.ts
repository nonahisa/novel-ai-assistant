import type { EpisodeFile } from "../models/types";
import type { Chapter } from "../models/chapter";
import type { ChapterSynopsis } from "../models/synopsis";
import { synopsisKey } from "../models/synopsis";
import {
  PLOT_SECTIONS,
  updatePlotMarkdown,
  type PlotSectionDef,
  type PlotSectionKey,
} from "./plotDoc";
import { groupEpisodesByChapter } from "./chapterGrouping";
import { episodePathFor } from "./bookStore";
import { episodeTitle, episodeUnit, formatChapterLabel } from "./episodeLabel";
import type { WorkFormatKey } from "./workFormat";
import { parseEpisodePlot } from "./episodePlotDoc";
import { episodePlotChapterFromFileName, episodePlotFileName } from "./resumeSheet";
import { EPISODE_PLOT_MOVING_PREFIX } from "./episodePlotOrder";
import { episodeNumberFromHint } from "./locateEpisode";
import {
  sumForeshadowCounts,
  ZERO_FORESHADOW_COUNTS,
  type ForeshadowChapterCounts,
} from "./foreshadowPlan";

/**
 * プロットモードの画面の材料（設計書6.4.8）。
 *
 * **この画面は plot.md の中身を持たない。** 6.4.3で決めたとおり、
 * 文書を欄に閉じ込めない——ここが作るのは「どこに何があるか」の目録
 * （節の目次・まだ立てていない見出しの名前・話の見取り図）だけで、
 * 中身は左のエディタにしか無い。
 *
 * VS Code APIに依存しない（画面もファイルも触らない純粋な組み立て）。
 */

/** 目次の1行 */
export interface PlotHeading {
  /** `## ` に続く見出しの文字列 */
  heading: string;
  /** 決まった項目のどれか。作者が立てた見出しは null */
  key: PlotSectionKey | null;
  /** 何行目にあるか（1始まり。エディタへ飛ばすのに使う） */
  line: number;
}

/**
 * 節の見出しを、行番号つきで拾う。
 *
 * **`##` だけを見る。** `#` は文書の題、`###` 以下は節の中の小見出しで、
 * どちらも `updatePlotMarkdown` が節として扱わない段である。目次だけが
 * 別の数え方をすると、押した先と書き足す先がずれる。
 *
 * **作者が立てた見出しも並べる。** 決まった項目だけの目次では、自由に
 * 書いた節（6.4.3）へ飛べない。
 */
export function listPlotHeadings(text: string): PlotHeading[] {
  const byHeading = new Map<string, PlotSectionKey>();
  for (const section of PLOT_SECTIONS) byHeading.set(section.heading, section.key);

  const headings: PlotHeading[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((line, index) => {
    const matched = /^##\s+(.+?)\s*$/.exec(line);
    if (!matched) return;
    headings.push({
      heading: matched[1],
      key: byHeading.get(matched[1]) ?? null,
      line: index + 1,
    });
  });
  return headings;
}

/**
 * まだ立てていない見出しの候補。
 *
 * 書き出し（`plotTemplate.ts`）が案内に名前だけ並べているものと同じ考えで、
 * **使いたい人には名前が要り、使わない人には空欄が要らない。**
 * 画面では薄く並べ、押されたときに初めて見出しを足す。
 */
export function unusedPlotSections(text: string): PlotSectionDef[] {
  const present = new Set(listPlotHeadings(text).map((entry) => entry.heading));
  return PLOT_SECTIONS.filter((section) => !present.has(section.heading));
}

/**
 * 見出しだけを立てたときに置く中身。
 *
 * `updatePlotMarkdown` は空の中身を書き足さない（何も渡していないのと
 * 同じ扱いになる）ので、案内を1行置く。**書き出しと同じものを置く**
 * ——案内があれば `isBlankPlotSection` は「まだ書かれていない」と数え、
 * 逆算（P-02）はそこを埋められる。
 */
const PLOT_SECTION_SEED = "<!-- ここに書きます -->";

export function plotSectionSeed(def: PlotSectionDef): string {
  const lines: string[] = [];
  if (def.hint) lines.push(`<!-- ${def.hint} -->`);
  if (def.list) lines.push("- ");
  if (lines.length === 0) lines.push(PLOT_SECTION_SEED);
  return lines.join("\n");
}

/**
 * 候補の見出しを**末尾へ**足す（設計書6.4.8）。
 *
 * 書き足しは `updatePlotMarkdown` の1本だけを通る（6.4.3。触らない節は
 * 1文字も変えず、決まった順へ割り込ませない）。
 *
 * **既にある見出しには触らない。** `updatePlotMarkdown` は見出しがあれば
 * その場で中身を差し替えるので、候補の判定がずれていた場合に
 * **作者の文章が案内で塗り潰される。** 候補は「無いもの」を指す言葉なので、
 * 在ったらそのまま返す。
 */
export function appendPlotSection(
  text: string,
  key: PlotSectionKey,
  options: { workTitle: string }
): string {
  const def = PLOT_SECTIONS.find((section) => section.key === key);
  if (!def) return text;
  if (listPlotHeadings(text).some((entry) => entry.heading === def.heading)) {
    return text;
  }
  return updatePlotMarkdown(text, { [key]: plotSectionSeed(def) }, options);
}

/** 一覧に添えるあらすじの長さ。1行に収まり、書き出しが分かる程度 */
export const SYNOPSIS_HEAD_LENGTH = 20;

/**
 * 各話あらすじの冒頭。**1行に畳む。**
 *
 * 見取り図の1行に添えるものなので、改行が入ると行の高さが揃わない。
 * 切ったことは `…` で示す（切ったのに切っていないように見せない）。
 */
export function synopsisHead(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SYNOPSIS_HEAD_LENGTH) return flat;
  return `${flat.slice(0, SYNOPSIS_HEAD_LENGTH)}…`;
}

/** 一覧に添える「この話の目標」の長さ。あらすじの冒頭より少し長く取る */
export const EPISODE_PLOT_GOAL_HEAD_LENGTH = 30;

/**
 * 単話プロットの「この話の目標」を1行に畳む（設計書6.4.8。作者の依頼、
 * 2026-09-23）。
 *
 * **読み方は `parseEpisodePlot` の1か所を通す**——問いかけのまま（丸ごと
 * 括弧書き）や空なら空を返し、一覧に出さない。書かれていない欄に
 * 問いかけの文を並べると、目標が書いてあるように見える。
 * 切ったことは `…` で示す（`synopsisHead` と同じ）。
 */
export function episodePlotGoalHead(text: string): string {
  const flat = parseEpisodePlot(text).goal.replace(/\s+/g, " ").trim();
  if (flat.length <= EPISODE_PLOT_GOAL_HEAD_LENGTH) return flat;
  return `${flat.slice(0, EPISODE_PLOT_GOAL_HEAD_LENGTH)}…`;
}

/** 見取り図の1行 */
export interface PlotEpisodeRow {
  /** 行を1つに定める鍵。ファイルの場所をそのまま使う */
  filePath: string;
  fileName: string;
  /** 「第3話」など。読み取れなければファイル名 */
  label: string;
  /** サブタイトル。無ければ空 */
  title: string;
  /** 単話プロットの置き場を決める話数。読めなければ null */
  chapter: number | null;
  /** 章立ての章名。章の外・台帳が空なら空文字（**捏造しない**） */
  chapterName: string;
  net: number;
  gross: number;
  /** 本文が書かれているか（空のファイルだけ作った状態と区別する） */
  hasManuscript: boolean;
  /** 未解決の競合があり、字数を数えていない */
  conflicted: boolean;
  /** 単話プロット（`設定/episode-plots/第N話.md`）があるか */
  hasEpisodePlot: boolean;
  /** 単話プロットを作れるか。**話数が読めない話は作れない**（6.36.2） */
  canCreateEpisodePlot: boolean;
  /** この行で押せるAI判定（設計書6.36.3）。**押せないものは並べない** */
  episodePlotChecks: EpisodePlotCheckAction[];
  /** 各話あらすじの冒頭。無ければ空 */
  synopsisHead: string;
  /** 単話プロットの「この話の目標」の1行（`episodePlotGoalHead`）。無ければ空 */
  goalHead: string;
  /**
   * この話で張った・回収した・回収予定の伏線の数（設計書6.35）。
   * **0 は画面に出さない**（呼ぶ側が落とす）。合本は範囲を足し合わせる
   */
  foreshadowCounts: ForeshadowChapterCounts;
  /**
   * 予定の話か（設計書6.4.8）。本文のファイルが無く、単話プロットだけがある。
   * このとき `filePath` は単話プロットの場所で、押すとプロットが開く
   */
  planned: boolean;
}

/**
 * 予定の話1件（設計書6.4.8）。**単話プロットのファイルそのもの**である。
 *
 * 予定のための台帳は作らない。単話プロットは `第N話.md` という話数だけで
 * 本文と結びつくので、本文の無い話数のプロットがそのまま「予定」になり、
 * 作者がその話数の本文を作れば何もしなくても同じ行へ結びつく。
 */
export interface PlannedEpisodePlot {
  chapter: number;
  /** 見出しに書いた題（`episodePlotTitleFromText`）。無ければ空 */
  title: string;
  /** 単話プロットの場所 */
  filePath: string;
  /** 「この話の目標」の1行（`episodePlotGoalHead`）。無ければ空・省略 */
  goal?: string;
}

/**
 * 単話プロットに掛けられるAI判定（設計書6.36.3）。
 *
 * - `design`：P-27。書いた設計だけを見る（**本文は要らない**）
 * - `contrast`：P-28。その話の本文と箇条書きを照らす
 */
export type EpisodePlotCheckAction = "design" | "contrast";

/**
 * ボタンの名前と説明。**画面に出す言葉はここだけが持つ。**
 *
 * プロットモードのパネルと詳細メニューの両方が読む。写しを作ると、
 * 片方だけ直したときに同じ操作が2つの名前で並ぶ。
 */
export const EPISODE_PLOT_CHECK_LABELS: Record<
  EpisodePlotCheckAction,
  { label: string; detail: string }
> = {
  design: {
    label: "設計を検査",
    detail:
      "単話プロットの展開が、この話の目標に向かっているかをAIに見せます。" +
      "本文は要りません。指摘するだけで、プロットは書き換えません。",
  },
  contrast: {
    label: "本文と照合",
    detail:
      "この話の本文と、単話プロットの箇条書きをAIで照らし合わせます。" +
      "本文もプロットも書き換えません。箇条書きのほうが古いこともあります。",
  },
};

/**
 * その行で押せるAI判定（設計書6.36.3）。
 *
 * **押しても何も起きないボタンを置かない。** 単話プロットが無ければ
 * 照らす相手が無く、本文が無ければ照合する先が無い。競合の跡が残る本文は
 * AI処理をブロックする（この作品の決まり）ので、照合の相手にしない。
 */
export function episodePlotChecksFor(
  row: Pick<PlotEpisodeRow, "hasEpisodePlot" | "hasManuscript" | "conflicted">
): EpisodePlotCheckAction[] {
  if (!row.hasEpisodePlot) return [];
  return row.hasManuscript && !row.conflicted
    ? ["design", "contrast"]
    : ["design"];
}

/**
 * その話の単話プロットが置かれる話数（設計書6.36.2）。
 *
 * **`createEpisodePlot` と同じ取り方**（合本なら最後の話数）。ずれると、
 * 画面が「無い」と言っている話のプロットが実は在ることになる。
 * 話数が読めない話（「プロローグ.txt」）は置き場の名前を作れないので null。
 */
export function episodePlotChapterOf(
  episode: Pick<EpisodeFile, "chapterStart" | "chapterEnd">
): number | null {
  return episode.chapterEnd ?? episode.chapterStart ?? null;
}

export interface PlotEpisodeRowsInput {
  /** 走査（`scanWork`）が返した並びのまま渡す。**ここで並べ替えない** */
  episodes: readonly EpisodeFile[];
  chapters: readonly Chapter[];
  workFolder: string;
  format?: WorkFormatKey;
  synopses: readonly ChapterSynopsis[];
  /** 単話プロットが既にある話数 */
  episodePlotChapters: ReadonlySet<number>;
  /**
   * 予定の話（本文の無い話数の単話プロット）。**本文のある話数のものが
   * 混じっていても捨てる**——読み込みと組み立てのあいだに本文ができたら、
   * そちらの行へ結びつける
   */
  plannedEpisodes?: readonly PlannedEpisodePlot[];
  /**
   * 書いた話の単話プロットの目標（話数 → 1行）。予定の話のものは
   * `plannedEpisodes` の `goal` で渡す（設計書6.4.8）
   */
  episodePlotGoals?: ReadonlyMap<number, string>;
  /** 話数ごとの伏線の数（`foreshadowCountsByChapter`。設計書6.35） */
  foreshadowCounts?: ReadonlyMap<number, ForeshadowChapterCounts>;
}

/**
 * その話数の本文があるか。
 *
 * **合本は範囲で見る。** 「第1〜10話」の合本があるのに第5話を予定として
 * 並べると、同じ話が2か所に出る。
 */
function isChapterWritten(
  episodes: readonly EpisodeFile[],
  chapter: number
): boolean {
  return episodes.some((episode) => {
    const start = episode.chapterStart;
    if (start === null) return false;
    const end = episode.chapterEnd ?? start;
    return start <= chapter && chapter <= end;
  });
}

/**
 * 単話プロットのある話数のうち、本文がまだ無いもの（＝予定の話）。話数の順。
 */
export function plannedEpisodePlotChapters(
  episodes: readonly EpisodeFile[],
  plotChapters: Iterable<number>
): number[] {
  return [...new Set(plotChapters)]
    .filter((chapter) => !isChapterWritten(episodes, chapter))
    .sort((left, right) => left - right);
}

/** 名前の形が違う単話プロット1件 */
export interface MisnamedEpisodePlot {
  name: string;
  /** 直せば並ぶ名前（`第N話.md`）。話数が読めない・既にその名前があれば null */
  suggested: string | null;
}

/**
 * 単話プロットの置き場にある、`第N話.md` の形でない .md（精査 R11 ③）。
 *
 * **読む側で別の形を覚えない。** 開く・作る・並べ替える側はどれも
 * `episodePlotFileName` の名前を探すので、一覧にだけ `episode_0005.md` を
 * 並べると、押したときに別の（空の）第5話を作ることになる。並べずに、
 * 名前を直せば並ぶことを知らせる。**名前は勝手に変えない**（作者のファイル）。
 *
 * 直す先の話数は `episodeNumberFromHint`（数字が2つ以上ある名前は読まない）で
 * 読み、読めなければ出さない——推測で話数を決めない。
 */
export function misnamedEpisodePlots(fileNames: readonly string[]): MisnamedEpisodePlot[] {
  const present = new Set(fileNames);
  const result: MisnamedEpisodePlot[] = [];
  for (const name of fileNames) {
    if (!/\.md$/iu.test(name)) continue;
    // 並べ替えの途中の一時名は、わざと形から外してある（`episodePlotOrder.ts`）
    if (name.startsWith(EPISODE_PLOT_MOVING_PREFIX)) continue;
    if (episodePlotChapterFromFileName(name) !== null) continue;
    const chapter = episodeNumberFromHint(name);
    const candidate = chapter === undefined ? null : episodePlotFileName(chapter);
    result.push({
      name,
      suggested: candidate && !present.has(candidate) ? candidate : null,
    });
  }
  return result;
}

/** 知らせに名前を並べる数（多いと知らせが読めなくなる） */
const MISNAMED_NOTICE_LIMIT = 5;

/** プロットモードの上に出す知らせ。無ければ null */
export function misnamedEpisodePlotNotice(
  misnamed: readonly MisnamedEpisodePlot[]
): string | null {
  if (misnamed.length === 0) return null;
  const shown = misnamed
    .slice(0, MISNAMED_NOTICE_LIMIT)
    .map((entry) =>
      entry.suggested ? `${entry.name}（「${entry.suggested}」にすると並びます）` : entry.name
    );
  const rest = misnamed.length - shown.length;
  return (
    `単話プロットの置き場に、名前が「第N話.md」の形でないため並べていないファイルがあります：` +
    `${shown.join("、")}${rest > 0 ? `、ほか${rest}件` : ""}。名前は変えていません。`
  );
}

/**
 * 予定の話を足すときの、既定の話数。
 *
 * **書いた話と予定の話の、最後の次。** 予定を続けて足すとき、毎回
 * 同じ番号を勧めて「既にあります」と言われるのを避ける。
 */
export function nextPlannedEpisodeNumber(
  episodes: readonly EpisodeFile[],
  plotChapters: Iterable<number>
): number {
  let last = 0;
  for (const episode of episodes) {
    const end = episode.chapterEnd ?? episode.chapterStart;
    if (end !== null && end > last) last = end;
  }
  for (const chapter of plotChapters) {
    if (chapter > last) last = chapter;
  }
  return last + 1;
}

/**
 * 作者が入れた話数を読む（予定の話を足すとき）。
 *
 * **本文のある話数・単話プロットが既にある話数は断る。** 前者は予定では
 * なく、後者は作者の書いたプロットを雛形で潰す道になる（書き込み側も
 * 新規作成でしか書かないが、押す前に言うほうが親切である）。
 *
 * 全角の数字と「第8話」という書き方は読む（打ちやすいように）。
 */
export function parsePlannedEpisodeNumber(
  text: string,
  episodes: readonly EpisodeFile[],
  plotChapters: Iterable<number>
): { chapter: number; problem?: undefined } | { chapter?: undefined; problem: string } {
  const flat = text.normalize("NFKC").trim();
  const matched = /^第?\s*(\d+)\s*話?$/.exec(flat);
  if (!matched) return { problem: "話数を数字で入れてください（例：12）。" };
  const chapter = Number(matched[1]);
  if (!Number.isSafeInteger(chapter) || chapter < 1) {
    return { problem: "話数は1以上の数字で入れてください。" };
  }
  if (isChapterWritten(episodes, chapter)) {
    return {
      problem: `第${chapter}話は本文があります。予定は、本文のまだ無い話数に足します。`,
    };
  }
  if (new Set(plotChapters).has(chapter)) {
    return {
      problem: `第${chapter}話の単話プロットは既にあります。見取り図から開けます。`,
    };
  }
  return { chapter };
}

/**
 * 話の見取り図を組み立てる（設計書6.4.8）。
 *
 * **並びは走査のまま。** 一覧・章立て・EPUBと同じ順でないと、
 * 上から読んで流れを追う道具にならない。
 */
export function buildPlotEpisodeRows(
  input: PlotEpisodeRowsInput
): PlotEpisodeRow[] {
  const chapterNames = chapterNameByPath(
    input.episodes,
    input.chapters,
    input.workFolder
  );
  const synopses = new Map<string, ChapterSynopsis>();
  for (const entry of input.synopses) {
    synopses.set(synopsisKey(entry.fileName, entry.chapter), entry);
  }

  const writtenRows = input.episodes.map((episode) => {
    const chapter = episodePlotChapterOf(episode);
    const label = formatChapterLabel(episode, input.format) || episode.fileName;
    const state = {
      hasManuscript: episode.counts.net > 0,
      conflicted: episode.hasConflictMarkers,
      hasEpisodePlot:
        chapter !== null && input.episodePlotChapters.has(chapter),
    };
    return {
      filePath: episode.filePath,
      fileName: episode.fileName,
      label,
      title: episodeTitle(episode, label) ?? "",
      chapter,
      chapterName:
        chapterNames.get(episodePathFor(input.workFolder, episode.filePath)) ??
        "",
      net: episode.counts.net,
      gross: episode.counts.gross,
      ...state,
      canCreateEpisodePlot: chapter !== null,
      episodePlotChecks: episodePlotChecksFor(state),
      synopsisHead: synopsisHead(findSynopsisFor(synopses, episode)?.synopsis ?? ""),
      goalHead:
        chapter !== null && state.hasEpisodePlot
          ? (input.episodePlotGoals?.get(chapter) ?? "")
          : "",
      foreshadowCounts: countsForSpan(
        input.foreshadowCounts,
        episode.chapterStart,
        episode.chapterEnd ?? episode.chapterStart
      ),
      planned: false,
      // 並べ込みの目印。画面へは出さない（下で落とす）
      sortChapter: episode.chapterStart,
    };
  });

  const planned = (input.plannedEpisodes ?? [])
    .filter((entry) => !isChapterWritten(input.episodes, entry.chapter))
    .sort((left, right) => left.chapter - right.chapter)
    .map((entry) => plannedRow(entry, input, synopses));

  return mergePlannedRows(writtenRows, planned).map(
    ({ sortChapter: _sortChapter, ...row }) => row
  );
}

type SortableRow = PlotEpisodeRow & { sortChapter: number | null };

/**
 * 予定の話の1行。**本文の行と同じ形**にして、画面の描き分けは
 * `planned` の1つで済ませる（行の形を2つ持つと、片方だけ直す）。
 */
function plannedRow(
  entry: PlannedEpisodePlot,
  input: PlotEpisodeRowsInput,
  synopses: ReadonlyMap<string, ChapterSynopsis>
): SortableRow {
  const state = { hasManuscript: false, conflicted: false, hasEpisodePlot: true };
  const synopsis = synopses.get(synopsisKey("", entry.chapter));
  return {
    filePath: entry.filePath,
    fileName: "",
    label: episodeUnit(input.format).label(entry.chapter),
    title: entry.title,
    chapter: entry.chapter,
    chapterName: "",
    net: 0,
    gross: 0,
    ...state,
    canCreateEpisodePlot: true,
    episodePlotChecks: episodePlotChecksFor(state),
    synopsisHead: synopsisHead(synopsis?.synopsis ?? ""),
    goalHead: entry.goal ?? "",
    foreshadowCounts: countsForSpan(
      input.foreshadowCounts,
      entry.chapter,
      entry.chapter
    ),
    planned: true,
    sortChapter: entry.chapter,
  };
}

/**
 * その行の伏線の数。話数が読めない話は数えない（推測で埋めない）。
 * **新しい器を返す**——共有の0を返すと、画面へ渡したあとで誰かが書き換えうる。
 */
function countsForSpan(
  counts: ReadonlyMap<number, ForeshadowChapterCounts> | undefined,
  from: number | null,
  to: number | null
): ForeshadowChapterCounts {
  if (!counts || from === null || to === null) {
    return { ...ZERO_FORESHADOW_COUNTS };
  }
  return sumForeshadowCounts(counts, from, to);
}

/**
 * 予定の話を、書いた話の並びへ差し込む。
 *
 * **書いた話の並びは動かさない**（走査の順。一覧・章立て・EPUBと同じ）。
 * 予定の話は、自分より大きな話数の本文の直前へ入れる。どれより大きければ
 * **最後の番号つきの話のあと**——あとがきのような話数の無い話は、
 * 走査が末尾へ回すので、その前に置く。
 *
 * 章の名前は、**同じ章の話に挟まれたときだけ**受け継ぐ。最後の話のあとの
 * 予定は、新しい章の始まりかもしれないので名前を付けない（捏造しない）。
 */
function mergePlannedRows(
  written: readonly SortableRow[],
  planned: readonly SortableRow[]
): SortableRow[] {
  if (planned.length === 0) return [...written];

  const merged: SortableRow[] = [];
  let rest = [...planned];
  let lastNumbered = -1;
  written.forEach((row, index) => {
    if (row.sortChapter !== null) lastNumbered = index;
  });

  written.forEach((row, index) => {
    if (row.sortChapter !== null) {
      const before = rest.filter((entry) => (entry.sortChapter ?? 0) < (row.sortChapter ?? 0));
      rest = rest.filter((entry) => !before.includes(entry));
      const previous = merged[merged.length - 1];
      const inherited =
        previous && previous.chapterName === row.chapterName
          ? row.chapterName
          : "";
      for (const entry of before) {
        merged.push(previous ? { ...entry, chapterName: inherited } : entry);
      }
    }
    merged.push(row);
    if (index === lastNumbered) {
      merged.push(...rest);
      rest = [];
    }
  });
  merged.push(...rest);
  return merged;
}

/**
 * その話のあらすじ。
 *
 * あらすじの鍵は**話数が読めれば話数だけ**（`synopsisKey`。改題でも
 * 追随するため）。合本のように開始と終了が違う話では両方を試し、
 * 話数の読めない話だけファイル名で引く。
 */
function findSynopsisFor(
  synopses: ReadonlyMap<string, ChapterSynopsis>,
  episode: EpisodeFile
): ChapterSynopsis | undefined {
  for (const chapter of [episode.chapterStart, episode.chapterEnd]) {
    if (chapter === null || chapter === undefined) continue;
    const found = synopses.get(synopsisKey(episode.fileName, chapter));
    if (found) return found;
  }
  return synopses.get(synopsisKey(episode.fileName, null));
}

/**
 * 話ごとの章名。**束ね方は作品一覧・EPUBと同じ部品**を通す
 * （`groupEpisodesByChapter`）。ここで別に束ねると、画面ごとに
 * 章の切れ目がずれる。
 */
function chapterNameByPath(
  episodes: readonly EpisodeFile[],
  chapters: readonly Chapter[],
  workFolder: string
): Map<string, string> {
  const names = new Map<string, string>();
  if (chapters.length === 0) return names;

  for (const group of groupEpisodesByChapter(episodes, chapters, workFolder)
    .groups) {
    // 開始の話が見つからない章は束ねる場所が決まらない（`episodes` が空）
    for (const episode of group.episodes) {
      names.set(
        episodePathFor(workFolder, episode.filePath),
        group.chapter.name
      );
    }
  }
  return names;
}

/**
 * パネルに並べるAIの入口（設計書6.4.8）。
 *
 * **既存のコマンドを呼ぶだけ**で、名前も説明もここには書かない
 * （`ACTION_TREE` から引く。簡単ステップメニューと同じ決まり）。
 * 改名されたら `test/unit/core/plotMode.test.ts` が落ちる。
 */
export const PLOT_MODE_AI_COMMANDS: readonly string[] = [
  "novelai.generatePlot",
  "novelai.plotInterview",
  "novelai.setPlotBasics",
];
