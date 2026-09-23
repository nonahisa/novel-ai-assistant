import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { DeviceWritingStats } from "../models/writingStats";
import { emptyScheduleFile, type ScheduleFile } from "../models/schedule";
import { isPosted, POSTING_SITES, type PostingLedger } from "../models/posting";
import type { WorkRegistry } from "../core/workRegistry";
import { ScheduleStore } from "../core/scheduleStore";
import { readWorkGoalsOrEmpty } from "../core/workGoalsStore";
import { targetCharsOf } from "../core/contestProgress";
import { scanWork } from "../core/scanner";
import { mergeDailyStats, statsDayKey } from "../core/writingStats";
import { WritingStatsStore } from "../core/writingStatsStore";
import { chooseCruisingPace } from "../core/contestForecast";
import { PostingStore } from "../core/postingStore";
import { episodePathFor } from "../core/bookStore";
import { episodePlotFileName, episodePlotTitleFromText } from "../core/resumeSheet";
import { buildEpisodeFacts } from "../core/scheduleEpisodes";
import { buildScheduleBoard, type ScheduleBoard, type WorkScheduleInput } from "../core/scheduleBoard";
import type { EpisodeFact, GoalsContestRef, PlanContext } from "../core/schedulePlan";
import { buildWorkCalendar, normalizeWorkload, type WorkloadSettings } from "../core/workCalendar";
import type { HolidaySet } from "../core/holidays";
import { logFailure, useLogFile } from "../core/logger";
import { boundaryHour } from "./writingProgress";
import { episodePlotsDirOf, listEpisodePlotChapters } from "./episodePlotNav";

/**
 * スケジュールの画面と知らせに要る材料を集める（設計書6.111）。
 *
 * **重い読み（走査・執筆量・投稿の記録）は、スケジュールのある作品だけ**にする。
 * スケジュールも応募先も無い作品は、並べる予定が無いので読まない。
 * 連載が無い作品では投稿の記録と単話プロットを読まない。
 */

export function scheduleToday(): string {
  return statsDayKey(new Date(), boundaryHour());
}

/**
 * 作業量の割合（設計書6.111.12）を設定から読む。読めない値は既定に戻し、
 * 戻したことを画面の上に出す（黙って使わない）。
 */
export function readWorkloadSettings(): { settings: WorkloadSettings; problems: string[] } {
  const config = vscode.workspace.getConfiguration("novelai.schedule");
  return normalizeWorkload({
    weekday: config.get<unknown>("weekdayWeight"),
    weekend: config.get<unknown>("weekendWeight"),
    holiday: config.get<unknown>("holidayWeight"),
    weekdayOverrides: config.get<unknown>("weekdayOverrides"),
    overlapPenalty: config.get<unknown>("overlapPenalty"),
  });
}

export async function loadScheduleBoard(
  registry: WorkRegistry,
  deviceId: string,
  options: { showFinished: boolean; holidays: HolidaySet }
): Promise<ScheduleBoard> {
  const today = scheduleToday();
  const works = registry.list();
  const workload = readWorkloadSettings();
  const calendar = buildWorkCalendar(workload.settings, options.holidays, today);

  // 巡航速度は、作品の記録が少なければ全作品の記録で測る（6.3.6.3）。全作品を1度だけ読む
  const statsByWork = new Map<string, DeviceWritingStats[]>();
  await Promise.all(
    works.map(async (work) => {
      const sets = await new WritingStatsStore(work, deviceId).loadAll().catch(() => [] as DeviceWritingStats[]);
      statsByWork.set(work.id, sets);
    })
  );
  const allDays = mergeDailyStats([...statsByWork.values()].flat());

  const inputs = await Promise.all(
    works.map((work) => workInput(work, today, statsByWork.get(work.id) ?? [], allDays))
  );
  return buildScheduleBoard(inputs, {
    today,
    now: new Date().toISOString(),
    showFinished: options.showFinished,
    calendar,
    notes: workload.problems,
  });
}

/** 作品目標設定の応募先を、スケジュールの公募の形にする（画面と .ics の書き出しで同じもの） */
export function goalsContestOf(goals: Awaited<ReturnType<typeof readWorkGoalsOrEmpty>>): GoalsContestRef | null {
  return goals.contest
    ? { name: goals.contest.name, deadline: goals.contest.deadline, targetChars: targetCharsOf(goals.contest) }
    : null;
}

async function workInput(
  work: WorkEntry,
  today: string,
  sets: DeviceWritingStats[],
  allDays: ReturnType<typeof mergeDailyStats>
): Promise<WorkScheduleInput> {
  const bare: PlanContext = {
    today,
    written: 0,
    perDay: 0,
    goalsContest: null,
    perEpisodeGoal: null,
    episodes: [],
  };

  let file: ScheduleFile;
  try {
    file = await new ScheduleStore(work).load();
  } catch (error) {
    return {
      workId: work.id,
      title: work.title,
      file: null,
      error: error instanceof Error ? error.message : String(error),
      context: bare,
    };
  }

  const goals = await readWorkGoalsOrEmpty(work);
  const goalsContest = goalsContestOf(goals);
  if (file.schedules.length === 0 && goalsContest === null) {
    return { workId: work.id, title: work.title, file: emptyScheduleFile(), error: null, context: bare };
  }

  let written = 0;
  let scanned: Awaited<ReturnType<typeof scanWork>> | null = null;
  try {
    scanned = await scanWork(work);
    written = scanned.stats.totals.net;
  } catch (error) {
    // 数えられなくても予定は並べる（0字として）
    useLogFile(work.folderPath);
    logFailure("スケジュール：本文を走査できなかった", { work: work.title, error: messageOf(error) });
  }

  const pace = chooseCruisingPace(mergeDailyStats(sets), allDays, today);

  let episodes: EpisodeFact[] = [];
  const serial = file.schedules.find((schedule) => schedule.kind === "webSerial");
  if (serial && scanned) {
    episodes = await serialEpisodeFacts(work, scanned.episodes, serial.serial?.site ?? null);
  }

  return {
    workId: work.id,
    title: work.title,
    file,
    error: null,
    context: {
      today,
      written,
      perDay: pace.perDay,
      goalsContest,
      perEpisodeGoal: goals.perEpisodeChars,
      episodes,
    },
  };
}

async function serialEpisodeFacts(
  work: WorkEntry,
  scannedEpisodes: Awaited<ReturnType<typeof scanWork>>["episodes"],
  site: (typeof POSTING_SITES)[number]["id"] | null
): Promise<EpisodeFact[]> {
  let ledger: PostingLedger | null = null;
  try {
    ledger = await new PostingStore(work).load();
  } catch (error) {
    // 読めなければ投稿済みを数えない（台帳は直さない）
    useLogFile(work.folderPath);
    logFailure("スケジュール：投稿の記録を読めなかった", { work: work.title, error: messageOf(error) });
  }
  const sites = site ? [site] : POSTING_SITES.map((entry) => entry.id);
  const posted = (episodePath: string, chapter: number | null): boolean =>
    ledger !== null &&
    sites.some((id) =>
      isPosted(ledger!, chapter === null ? episodePath : { episodePath, chapter }, id)
    );

  const writtenChapters = new Set<number>();
  const scannedLike = scannedEpisodes.map((episode) => {
    const relative = episodePathFor(work.folderPath, episode.filePath);
    if (episode.chapterStart !== null) {
      for (let chapter = episode.chapterStart; chapter <= (episode.chapterEnd ?? episode.chapterStart); chapter++) {
        writtenChapters.add(chapter);
      }
    }
    return {
      chapterStart: episode.chapterStart,
      chapterEnd: episode.chapterEnd,
      net: episode.counts.net,
      title: episode.subtitle ?? episode.metaTitle ?? null,
      isPosted: (chapter: number | null) => posted(relative, chapter),
    };
  });

  // 予定の話（本文の無い話数の単話プロット）の題。本文のある話数は読まない
  const plannedTitles = new Map<number, string | null>();
  try {
    const directory = await episodePlotsDirOf(work);
    for (const chapter of await listEpisodePlotChapters(directory)) {
      if (writtenChapters.has(chapter)) continue;
      let title: string | null = null;
      try {
        const bytes = await vscode.workspace.fs.readFile(
          paths.toUri(paths.join(directory, episodePlotFileName(chapter)))
        );
        title = episodePlotTitleFromText(new TextDecoder().decode(bytes)) || null;
      } catch {
        // 題が読めなくても、予定の話としては並べる
      }
      plannedTitles.set(chapter, title);
    }
  } catch (error) {
    useLogFile(work.folderPath);
    logFailure("スケジュール：単話プロットを読めなかった", { work: work.title, error: messageOf(error) });
  }

  return buildEpisodeFacts(scannedLike, plannedTitles);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
