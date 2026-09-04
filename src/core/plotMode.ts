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
import { episodeTitle, formatChapterLabel } from "./episodeLabel";
import type { WorkFormatKey } from "./workFormat";

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
  /** 各話あらすじの冒頭。無ければ空 */
  synopsisHead: string;
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

  return input.episodes.map((episode) => {
    const chapter = episodePlotChapterOf(episode);
    const label = formatChapterLabel(episode, input.format) || episode.fileName;
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
      hasManuscript: episode.counts.net > 0,
      conflicted: episode.hasConflictMarkers,
      hasEpisodePlot:
        chapter !== null && input.episodePlotChapters.has(chapter),
      canCreateEpisodePlot: chapter !== null,
      synopsisHead: synopsisHead(findSynopsisFor(synopses, episode)?.synopsis ?? ""),
    };
  });
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
 * 改名されたら `test/unit/plotMode.test.ts` が落ちる。
 */
export const PLOT_MODE_AI_COMMANDS: readonly string[] = [
  "novelai.generatePlot",
  "novelai.plotInterview",
  "novelai.setPlotBasics",
];
