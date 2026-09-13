import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { readPlotText } from "../core/plotFile";
import { isBlankPlotSection, parsePlotMarkdown } from "../core/plotDoc";
import { ChapterStore } from "../core/chapterStore";
import { groupEpisodesByChapter } from "../core/chapterGrouping";
import { findLatestEpisode } from "../core/latestEpisode";
import { readTextFile } from "../core/textFile";
import {
  collectedLabelIndex,
  episodeTitle,
  episodeUnit,
  formatChapterLabel,
} from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { SynopsisStore } from "../core/synopsisStore";
import { createForeshadowStore } from "../core/foreshadowStore";
import { WritingStatsStore } from "../core/writingStatsStore";
import { mergeDailyStats, statsDayKey } from "../core/writingStats";
import { boundaryHour, dailyGoal, summarize } from "./writingProgress";
import {
  countModeLabel,
  currentCountMode,
  pickCount,
} from "../core/countSettings";
import { atomicWriteFile } from "../core/atomicWrite";
import { pathExists } from "../core/fileSystem";
import { logFailure, useLogFile } from "../core/logger";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { openGeneratedMarkdown, openInDefaultEditor } from "../views/openDocument";
import {
  buildEpisodePlotTemplate,
  buildResumeSheet,
  EPISODE_PLOTS_DIR,
  episodePlotFileName,
  RESUME_SHEET_KIND,
  RESUME_SYNOPSIS_COUNT,
  tailOfEpisodeFile,
  type ResumeChapter,
  type ResumeEpisodePlot,
  type ResumeForeshadow,
  type ResumeMemo,
  type ResumeOverview,
  type ResumeSynopsis,
  type ResumeTodayGoal,
} from "../core/resumeSheet";
import { parseMemos } from "../core/sceneMemo";

/**
 * 執筆再開支援と単話プロット（設計書6.36）のうち、**AIを使わない口**。
 *
 * 昨日の続きを書き始めるとき、作者は「どこまで書いたか」「何を張ったままか」
 * を思い出すところから始める。それを1枚にまとめて出すのがここである。
 *
 * **AIを1度も呼ばない。** 押した瞬間に出ることに意味がある。
 * 待たされるなら原稿を直接開いたほうが早く、この機能を通る理由が無くなる。
 * AIの判定（P-27・P-28）は別の口として後から足す（6.36.3）。
 *
 * **原稿は書き換えない。** 読むだけである。唯一書くのは単話プロットの
 * 雛形で、それも**新規作成だけ**（既にあれば開くだけ）。
 */

/** 再開の1枚を組み立てて開く（設計書6.36.1） */
export async function resumeWriting(
  work: WorkEntry,
  deviceId: string
): Promise<void> {
  const notices: string[] = [];
  const { episodes } = await scanWork(work);
  const format = await readWorkFormat(work);
  const latest = findLatestEpisode(episodes);

  const chapter = chapterOf(latest);
  const config = await readWorkConfig(work);
  const paths = workPaths(work, config);

  const sheet = buildResumeSheet({
    workTitle: work.title,
    overview: await loadOverview(work, episodes, chapter, notices),
    latest: latest
      ? {
          label: labelOf(latest, format),
          title: episodeTitle(latest, formatChapterLabel(latest, format)),
          chars: pickCount(latest.counts, currentCountMode()),
          countLabel: countModeLabel(currentCountMode()),
          tail: await readTail(latest, notices),
        }
      : null,
    synopses: await recentSynopses(work, chapter, format, notices),
    openForeshadows: await loadOpenForeshadows(work, notices),
    openMemos: await loadOpenMemos(episodes, format, notices),
    episodePlot: await readEpisodePlot(paths, chapter, notices),
    todayGoal: await todayGoal(work, deviceId, notices),
    notices,
  });

  // どの画面で読むかは作者の割り当てに任せる（`openGeneratedMarkdown`）。
  // **ファイル名の前置きは種類だけ**にする（作品名は見出しに入っている）
  await openGeneratedMarkdown(
    RESUME_SHEET_KIND,
    sheet,
    { preview: false },
    { work }
  );
}

/**
 * 単話プロットの雛形を作って開く（設計書6.36.2）。
 *
 * **既にあるものは上書きしない。** 書きかけのプロットを雛形で潰しては、
 * この機能の目的そのものを裏切ることになる。
 */
export async function createEpisodePlot(
  work: WorkEntry,
  /**
   * どの話か。**決まっているなら訊かない**——プロットモードの一覧
   * （設計書6.4.8）は行ごとに押すので、そこから何話かをもう一度
   * 選ばせるのは同じことを2度聞くことになる。
   */
  chapter?: number,
  /**
   * どこへ開くか。プロットモード（6.4.8）は**左の面へ**出す
   * ——押したのはパネル（右）なので、既定のままだとパネルの上に重なる。
   */
  showOptions?: vscode.TextDocumentShowOptions
): Promise<void> {
  const picked =
    chapter === undefined ? await pickEpisodeChapter(work) : chapter;
  if (picked === undefined) return;
  await createEpisodePlotFile(work, picked, showOptions);
}

/** どの話の単話プロットを作るかを選ばせる。選ばれなければ undefined */
async function pickEpisodeChapter(
  work: WorkEntry
): Promise<number | undefined> {
  const { episodes } = await scanWork(work);
  const format = await readWorkFormat(work);

  // 話数の読めない話（「プロローグ.txt」など）は選べない。
  // `第N話.md` という置き場の名前を作れないためである
  const numbered = episodes
    .map((episode) => ({ episode, chapter: chapterOf(episode) }))
    .filter(
      (entry): entry is { episode: EpisodeFile; chapter: number } =>
        entry.chapter !== null
    )
    .sort((left, right) => right.chapter - left.chapter);

  if (numbered.length === 0) {
    void vscode.window.showInformationMessage(
      "話数の分かる本文がありません。ファイル名に話数を入れると、単話プロットを作れます。"
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      ...numbered.map((entry, index) => ({
        label: labelOf(entry.episode, format),
        // 既定は最新話。並びの先頭に置いたうえで、そうと分かるようにする
        description: index === 0 ? "最新話" : undefined,
        detail:
          episodeTitle(
            entry.episode,
            formatChapterLabel(entry.episode, format)
          ) ?? undefined,
        chapter: entry.chapter,
      })),
      cancelItem(),
    ],
    {
      title: "どの話の単話プロットを作りますか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("chapter" in picked)) return undefined;
  return picked.chapter;
}

/**
 * 雛形を作って開く。**既にあるものは上書きしない**（設計書6.36.2）。
 *
 * 選ぶところと分けてあるのは、プロットモードの一覧（6.4.8）が
 * 話数を決めたうえで呼ぶためである。**書き込みの道は1本のまま**。
 */
async function createEpisodePlotFile(
  work: WorkEntry,
  chapter: number,
  showOptions?: vscode.TextDocumentShowOptions
): Promise<void> {
  const config = await readWorkConfig(work);
  const directory = path.join(
    workPaths(work, config).settings,
    EPISODE_PLOTS_DIR
  );
  const filePath = path.join(directory, episodePlotFileName(chapter));

  if (await pathExists(filePath)) {
    await openInDefaultEditor(filePath, showOptions);
    void vscode.window.showInformationMessage(
      `第${chapter}話の単話プロットは既にあります。そのまま開きました。`
    );
    return;
  }

  try {
    await vscode.workspace.fs.createDirectory(path.toUri(directory));
    // **新規作成でしか書かない**（`atomicWrite.ts` の制約）。
    // ここへ来る時点で既存は除いてあるが、その間に作られていたら失敗させる
    await atomicWriteFile(
      filePath,
      new TextEncoder().encode(buildEpisodePlotTemplate(chapter)),
      { mode: "create" }
    );
  } catch (error) {
    const detail = messageOf(error);
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）
    useLogFile(work.folderPath);
    logFailure("単話プロットの作成に失敗", {
      置き場: filePath,
      詳細: detail,
    });
    void vscode.window.showErrorMessage(
      `単話プロットを作れませんでした：${detail}`
    );
    return;
  }

  await openInDefaultEditor(filePath, showOptions);
  void vscode.window.showInformationMessage(
    `第${chapter}話の単話プロットを作りました。視点・目標・展開を書いてください（AIは書きません）。`
  );
}

/**
 * 作品の大きな流れを集める（設計書6.36.1）。
 *
 * **AIを呼ばない。** 材料はどれも既に作品の中にある——プロットの
 * 「あらすじ」節、章立ての台帳、走査の結果。
 *
 * **読めなくても止めない。** 大きな流れは「あると助かる」ものであって、
 * 無いと再開できないものではない。読めなかったら断りを1行残して先へ進む
 * （この1枚のほかの節と同じ扱い）。
 */
async function loadOverview(
  work: WorkEntry,
  episodes: readonly EpisodeFile[],
  latestChapter: number | null,
  notices: string[]
): Promise<ResumeOverview> {
  return {
    plotOutline: plotOutlineOf(await readPlotText(work)),
    chapters: await loadChapterRows(work, episodes, latestChapter, notices),
    totalEpisodes: episodes.length,
    latestChapter,
  };
}

/** プロットの「あらすじ」節だけを取る（ほかの節は大きな流れではない） */
function plotOutlineOf(text: string): string {
  const outline = parsePlotMarkdown(text).sections.outline ?? "";
  return isBlankPlotSection(outline) ? "" : outline.trim();
}

/**
 * 章の並びと、いまどの章にいるか。
 *
 * **章立てが無い作品では空を返す**（この作品には章という区切りが無い、
 * というのが事実であって、欠けているわけではない）。
 */
async function loadChapterRows(
  work: WorkEntry,
  episodes: readonly EpisodeFile[],
  latestChapter: number | null,
  notices: string[]
): Promise<ResumeChapter[]> {
  let chapters;
  try {
    chapters = (await new ChapterStore(work).load()).chapters;
  } catch (error) {
    notices.push(`章立てを読めませんでした：${messageOf(error)}`);
    return [];
  }
  if (chapters.length === 0) return [];

  const { ungrouped, groups } = groupEpisodesByChapter(
    episodes,
    chapters,
    work.folderPath
  );

  const rows = groups.map((group) =>
    chapterRow(group.chapter.name, group.episodes, latestChapter)
  );
  // **章の前に置かれた話も数に入れる。** 落とすと、章ごとの合計と
  // 「いま何話まで」が食い違い、どちらが正しいのか読む側に分からない
  if (ungrouped.length > 0) {
    rows.unshift(chapterRow("（章の前）", ungrouped, latestChapter));
  }
  return rows;
}

function chapterRow(
  name: string,
  episodes: readonly EpisodeFile[],
  latestChapter: number | null
): ResumeChapter {
  const starts = episodes
    .map((episode) => episode.chapterStart)
    .filter((value): value is number => typeof value === "number");
  const ends = episodes
    .map((episode) => episode.chapterEnd ?? episode.chapterStart)
    .filter((value): value is number => typeof value === "number");
  const from = starts.length > 0 ? Math.min(...starts) : null;
  const to = ends.length > 0 ? Math.max(...ends) : null;
  return {
    name,
    episodeCount: episodes.length,
    from,
    to,
    // **いま書いている話が入っているか。** 端も含める（章の最後の話を
    // 書いているときに「いまここ」が消えると、居場所が分からなくなる）
    current:
      latestChapter !== null &&
      from !== null &&
      to !== null &&
      latestChapter >= from &&
      latestChapter <= to,
  };
}

/** その話の話数。合本なら最後の話数を見る。読めなければ null */
function chapterOf(episode: EpisodeFile | undefined): number | null {
  if (!episode) return null;
  return episode.chapterEnd ?? episode.chapterStart ?? null;
}

/**
 * 一覧に出す見出し。
 *
 * **話数が読めないファイルは、ファイル名で示す。** 空の見出しを出すと、
 * どの話のことを言っているのか分からなくなる。
 */
function labelOf(
  episode: EpisodeFile,
  format: WorkFormatKey | undefined
): string {
  return formatChapterLabel(episode, format) || episode.fileName;
}

/**
 * 本文に残っているシーンメモを集める（設計書6.40.5）。
 *
 * **本文をもう一度読む。** 走査は一覧の印のための短い1行しか持っていない
 * ので、中身を並べるには読み直すしかない。この1枚は押した瞬間に出る
 * ことに意味があるが、読むだけで19話・4万字なら一瞬である。
 *
 * **読めない話があっても1枚は出す。** 断り書きを足して先へ進む。
 *
 * **合本では、メモの行からその話の見出しを引く。** ファイル単位の見出しを
 * 使い回すと、全メモに「第1〜219話」が付いて、どの話のメモか分からない
 * （2026-09-12。シーンメモのパネルも同じ直し方をしている）。
 */
async function loadOpenMemos(
  episodes: readonly EpisodeFile[],
  format: WorkFormatKey | undefined,
  notices: string[]
): Promise<ResumeMemo[]> {
  const memos: ResumeMemo[] = [];
  for (const episode of episodes) {
    // 競合の跡が残ったままのファイルは触らない（末尾の扱いと同じ）
    if (episode.hasConflictMarkers) continue;
    try {
      const content = await readTextFile(episode.filePath);
      // 索引は1ファイルにつき1度だけ作る（合本は70万字になりうる）
      const labels = collectedLabelIndex(
        content.text,
        labelOf(episode, format),
        format
      );
      for (const memo of parseMemos(content.text, episode.filePath)) {
        memos.push({
          label: labels.labelAt(memo.line),
          line: memo.line,
          tag: memo.tag,
          text: memo.text,
        });
      }
    } catch (error) {
      notices.push(
        `${episode.fileName} のシーンメモを読めませんでした：${messageOf(error)}`
      );
    }
  }
  return memos;
}

/**
 * 最新話の末尾を読む。
 *
 * **読めなくても1枚は出す。** 末尾が無いだけで、あらすじも伏線も
 * 見られなくなるほうが困る。
 *
 * 本文の選び方は `tailOfEpisodeFile` が持つ（合本なら最後の話、
 * そうでなければ頭書きを外した本文）。ここは読むだけにする。
 */
async function readTail(
  latest: EpisodeFile,
  notices: string[]
): Promise<string> {
  if (latest.hasConflictMarkers) {
    // 競合の跡が残ったまま読むと、両方の版が混ざった文章を
    // 「前回書いたもの」として見せることになる
    notices.push(
      `${latest.fileName} に同期の競合の跡が残っています。末尾は出しません（先に競合を解消してください）。`
    );
    return "";
  }

  try {
    const content = await readTextFile(latest.filePath);
    return tailOfEpisodeFile(latest.filePath, content.text, latest);
  } catch (error) {
    notices.push(`${latest.fileName} を読めませんでした：${messageOf(error)}`);
    return "";
  }
}

/**
 * 前話までのあらすじを、直近から数話ぶん取る。
 *
 * **`chapter_synopses.json` から読む。** `設定/synopsis.md` は同じ内容を
 * 載せているが、あちらは作者が手で書き足す文書で、各話あらすじの節は
 * 毎回そこから組み立て直される生成物である（`synopsisDoc.ts`）。
 * 真実の在り処のほうを読めば、話数・題・本文が分かれたまま受け取れる。
 *
 * **いま書いている話は入れない。** 「前話まで」であって、これから書く話の
 * あらすじ（前に書いていれば残っている）は思い出す材料にならない。
 */
async function recentSynopses(
  work: WorkEntry,
  chapter: number | null,
  format: WorkFormatKey | undefined,
  notices: string[]
): Promise<ResumeSynopsis[]> {
  let episodes;
  try {
    episodes = (await new SynopsisStore(work).load()).episodes;
  } catch (error) {
    notices.push(`各話あらすじを読めませんでした：${messageOf(error)}`);
    return [];
  }

  const unit = episodeUnit(format);
  return episodes
    // いま書いている話より前だけを取る。**話数の無いあらすじ（「プロローグ」）は
    // 落とす**——並びの最後に来るので、混ぜると直近3話がそちらで埋まる
    .filter((episode) =>
      chapter === null ? true : episode.chapter !== null && episode.chapter < chapter
    )
    .slice(-RESUME_SYNOPSIS_COUNT)
    .map((episode) => ({
      label: episode.chapter === null ? "" : unit.label(episode.chapter),
      title: episode.title,
      synopsis: episode.synopsis.trim(),
    }));
}

/** 未回収の伏線（設計書6.35.1）。話数の早い順に並べる */
async function loadOpenForeshadows(
  work: WorkEntry,
  notices: string[]
): Promise<ResumeForeshadow[]> {
  let loaded;
  try {
    loaded = await createForeshadowStore(work).loadAll();
  } catch (error) {
    notices.push(`伏線の台帳を読めませんでした：${messageOf(error)}`);
    return [];
  }

  if (loaded.errors.length > 0) {
    notices.push(
      `読み込めない伏線が ${loaded.errors.length} 件あります。残りだけを並べています。`
    );
  }

  return loaded.records
    .filter((record) => record.status === "open")
    .sort((left, right) => {
      const a = left.plantedChapter;
      const b = right.plantedChapter;
      if (a === b) return left.id.localeCompare(right.id);
      // 話数不明は最後へ回す（一覧のMarkdownと同じ並び）
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    })
    .map((record) => ({
      label: record.label,
      plantedChapter: record.plantedChapter,
      quote: record.plantedQuote,
      note: record.note,
    }));
}

/** この話の単話プロット。無ければ「作れる場所」を返す */
async function readEpisodePlot(
  paths: { root: string; settings: string },
  chapter: number | null,
  notices: string[]
): Promise<ResumeEpisodePlot> {
  if (chapter === null) return { kind: "unnumbered" };

  const filePath = path.join(
    paths.settings,
    EPISODE_PLOTS_DIR,
    episodePlotFileName(chapter)
  );
  // 置き場は作品フォルダーからの相対で見せる。絶対パスは長くて読みにくい。
  // 区切りは「/」に揃える（Windowsの「\」のままだと、文書として読みづらい）
  const shown = path.relative(paths.root, filePath).replace(/\\/g, "/");

  if (!(await pathExists(filePath))) return { kind: "missing", path: shown };

  try {
    const content = await readTextFile(filePath);
    return { kind: "found", path: shown, body: content.text };
  } catch (error) {
    notices.push(`${shown} を読めませんでした：${messageOf(error)}`);
    return { kind: "missing", path: shown };
  }
}

/**
 * 今日の執筆量と目標。
 *
 * **目標を決めていなければ、行ごと出さない。** 「0/0字」は何も伝えない
 * （`describeStatusBarProgress` と同じ考え方）。
 */
async function todayGoal(
  work: WorkEntry,
  deviceId: string,
  notices: string[]
): Promise<ResumeTodayGoal | null> {
  const goal = dailyGoal();
  if (goal <= 0) return null;

  try {
    const days = mergeDailyStats(
      await new WritingStatsStore(work, deviceId).loadAll()
    );
    const summary = summarize(days, statsDayKey(new Date(), boundaryHour()));
    return {
      written: summary.todayProgress.written,
      goal: summary.todayProgress.goal,
      remaining: summary.todayProgress.remaining,
    };
  } catch (error) {
    notices.push(`今日の執筆量を読めませんでした：${messageOf(error)}`);
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
