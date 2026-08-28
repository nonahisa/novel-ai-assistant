import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry, WorkStats } from "../models/types";
import type {
  DailyStat,
  FileCountMap,
  WritingMeasurement,
} from "../models/writingStats";
import { logFailure } from "../core/logger";
import {
  currentStreak,
  fileCountKey,
  fileNetOn,
  mergeDailyStats,
  monthKey,
  progressAgainstGoal,
  statsDayKey,
  sumRange,
  type GoalProgress,
} from "../core/writingStats";
import { WritingStatsStore } from "../core/writingStatsStore";

/**
 * 執筆量の記録係（設計書6.3）。
 *
 * 保存のたびに作品全体の字数を測り、前回との差をその日の執筆量として積む。
 * 走査そのものは作品一覧の走査結果を借りる（`statsFor`）ので、
 * 1回の保存でファイルを2度読むことはない。
 *
 * **記録に失敗しても執筆は止めない。** 統計は失われても原稿は無事なので、
 * 画面には出さずログにだけ残す。
 */
/**
 * 走査の結果。**話ごとの文字数まで受け取る**（作者の指示、2026-08-29
 * 「記録の持ち方を細かくして」）。
 *
 * 集計だけでは「どのファイルで書いたか」が分からない。走査は既に話ごとの
 * 文字数を数えている（`scanner.ts`）ので、**測り直さずにそれを借りる。**
 */
export interface WorkScan {
  stats: WorkStats;
  episodes: readonly EpisodeFile[];
}

export class WritingProgressTracker {
  /** 作品ごとの直近の集計。ステータスバーが毎回ファイルを読まないために持つ */
  private readonly cache = new Map<string, WritingSummary>();

  constructor(
    private readonly deviceId: string,
    private readonly statsFor: (work: WorkEntry) => Promise<WorkScan>
  ) {}

  /** 設定で記録そのものを止められる。書いた量を残したくない作者もいる */
  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration("novelai")
      .get<boolean>("stats.enabled", true);
  }

  /** 保存されたときに呼ぶ。差があればその日の執筆量に積む */
  async record(work: WorkEntry): Promise<void> {
    if (!this.enabled()) return;
    try {
      const scan = await this.statsFor(work);
      await this.store(work).record(toMeasurement(work, scan), {
        boundaryHour: boundaryHour(),
      });
      // 記録が変わったので、次にステータスバーが必要としたときに読み直す
      this.cache.delete(work.id);
    } catch (error) {
      logFailure("執筆量の記録に失敗", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 記録を付けずに基準だけ置き直す。
   *
   * 別の環境の変更を取り込んだ直後（git pull）に呼ぶ。取り込んだ量を
   * この環境で書いたことにすると、同じ文章を2台ぶん数えることになる。
   */
  async rebaseline(work: WorkEntry): Promise<void> {
    if (!this.enabled()) return;
    try {
      const scan = await this.statsFor(work);
      await this.store(work).rebaseline(toMeasurement(work, scan));
      this.cache.delete(work.id);
    } catch (error) {
      logFailure("執筆量の基準の置き直しに失敗", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** ステータスバー用の要約。読めなければ undefined */
  async summary(work: WorkEntry): Promise<WritingSummary | undefined> {
    if (!this.enabled()) return undefined;
    const today = statsDayKey(new Date(), boundaryHour());
    const cached = this.cache.get(work.id);
    if (cached && cached.today === today) return cached;

    try {
      const sets = await this.store(work).loadAll();
      const summary = summarize(mergeDailyStats(sets), today);
      this.cache.set(work.id, summary);
      return summary;
    } catch {
      // 統計が読めなくても文字数表示は続ける
      return undefined;
    }
  }

  /**
   * そのファイルで今日書いた純文字数（作者の指示、2026-08-29）。
   *
   * 原稿エディタの下段に出す。**全端末ぶんを合算する**——同じ話を
   * ノートPCと自宅の両方で書いた日に、片方しか出ないのはおかしい
   * （合算するのは日ごとの記録と同じ流儀。設計書5.5.6）。
   *
   * 記録そのものを止めている作者には `undefined` を返す。0を返すと
   * 「今日は1字も書いていない」と読めてしまう。
   */
  async todayFileCount(
    work: WorkEntry,
    filePath: string
  ): Promise<number | undefined> {
    if (!this.enabled()) return undefined;
    try {
      const sets = await this.store(work).loadAll();
      const today = statsDayKey(new Date(), boundaryHour());
      const key = fileCountKey(path.relative(work.folderPath, filePath));
      return fileNetOn(mergeDailyStats(sets), today, key);
    } catch {
      // 統計が読めなくても本文の字数表示は続ける
      return undefined;
    }
  }

  invalidate(workId?: string): void {
    if (workId) {
      this.cache.delete(workId);
    } else {
      this.cache.clear();
    }
  }

  private store(work: WorkEntry): WritingStatsStore {
    return new WritingStatsStore(work, this.deviceId);
  }
}

export interface WritingSummary {
  /** 集計した日（日付境界を適用済み） */
  today: string;
  todayProgress: GoalProgress;
  monthProgress: GoalProgress;
  /** 今月書いた日数 */
  monthActiveDays: number;
  streak: number;
}

/** 全端末ぶんを合算した記録から、今日・今月・連続日数をまとめる */
export function summarize(days: DailyStat[], today: string): WritingSummary {
  const month = monthKey(today);
  const todayTotal = sumRange(days, today, today);
  const monthTotal = sumRange(days, `${month}-01`, `${month}-31`);
  return {
    today,
    todayProgress: progressAgainstGoal(todayTotal.net, dailyGoal()),
    monthProgress: progressAgainstGoal(monthTotal.net, monthlyGoal()),
    monthActiveDays: monthTotal.activeDays,
    streak: currentStreak(days, today),
  };
}

/**
 * 走査の結果を、記録の入力へ。
 *
 * **内訳の鍵は作品フォルダーからの相対パス**にする。絶対パスだと、
 * 同じ作品を別の場所へ置いた環境（`C:\小説` と `~/novels`）で
 * 別のファイルとして数えられ、合算したときに二重になる。
 */
function toMeasurement(work: WorkEntry, scan: WorkScan): WritingMeasurement {
  const files: FileCountMap = {};
  for (const episode of scan.episodes) {
    // 競合を含む話は走査が0字として扱う（集計からも外れている）。
    // 内訳にも載せない——直った瞬間に「数万字書いた」ことになる
    if (episode.hasConflictMarkers) continue;
    const key = fileCountKey(path.relative(work.folderPath, episode.filePath));
    files[key] = { net: episode.counts.net, gross: episode.counts.gross };
  }
  return {
    net: scan.stats.totals.net,
    gross: scan.stats.totals.gross,
    fileCount: scan.stats.fileCount,
    conflictedCount: scan.stats.conflictedCount,
    files,
  };
}

export function boundaryHour(): number {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<number>("stats.dayBoundaryHour", 4);
}

export function weekStart(): number {
  const value = vscode.workspace
    .getConfiguration("novelai")
    .get<string>("stats.weekStart", "monday");
  return value === "sunday" ? 0 : 1;
}

export function dailyGoal(): number {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<number>("stats.dailyGoal", 0);
}

export function monthlyGoal(): number {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<number>("stats.monthlyGoal", 0);
}

/**
 * ステータスバーに出す一言。
 *
 * **目標が未設定なら「今日 +560字」だけにする。** 目標を設定していない作者に
 * 「0/0」のような意味のない数字を見せない。
 */
export function describeStatusBarProgress(summary: WritingSummary): string {
  const { written, goal } = summary.todayProgress;
  const value = written.toLocaleString("ja-JP");
  if (goal <= 0) {
    return written === 0 ? "今日 0字" : `今日 ${written > 0 ? "+" : ""}${value}字`;
  }
  return `今日 ${value}/${goal.toLocaleString("ja-JP")}字`;
}
