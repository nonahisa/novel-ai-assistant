import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { WorkGoals } from "../models/workGoals";
import type { DeviceWritingStats } from "../models/writingStats";
import {
  appendAchievements,
  celebrationSize,
  dailyAchievementId,
  describeAchievement,
  footCheer,
  judgeAchievements,
  monthlyAchievementId,
  pendingCelebrations,
  toAchievements,
  type Achievement,
  type CelebrationSize,
} from "../core/celebrations";
import { AchievementStore } from "../core/achievementStore";
import { logFailure, useLogFile } from "../core/logger";
import {
  mergeDailyStats,
  monthKey,
  statsDayKey,
  sumRange,
} from "../core/writingStats";
import { WritingStatsStore } from "../core/writingStatsStore";
import { readWorkGoalsOrEmpty } from "../core/workGoalsStore";
import type { RecordOutcome } from "./writingProgress";

/**
 * 目標の達成を祝う係（設計書6.3.8）。
 *
 * 何に届いたかの判定は `core/celebrations.ts` が持つ。ここは
 * **いつ判定するか**（保存を記録し終えたとき）と、**どこに覚えておくか**を受け持つ。
 *
 * | 何を | どこに | なぜ |
 * |---|---|---|
 * | 1日・1月の達成 | globalState（この端末） | 目標が全作品で共有の設定なので、作品のどれにも属さない |
 * | 作品・締切の達成 | 作品の `.aiwriter/achievements.json` | 作品についての事実。別の環境でも二度祝わない |
 * | 執筆統計で見せたか | globalState（この端末） | 見たかどうかは画面の前の作者の話で、作品の事実ではない |
 *
 * **祝い方は2か所だけ。** 原稿エディターの下の欄に一言、執筆統計に風船と花火。
 * 書いている最中の画面には何も飛ばさない——手が止まるからである。
 */

const GLOBAL_KEY = "novelai.celebrations.global";
const SHOWN_KEY = "novelai.celebrations.shown";
/** 見せた印の上限。記録の上限と揃える（それより古い達成は記録からも落ちている） */
const SHOWN_LIMIT = 400;

export interface CelebrationSettings {
  enabled: boolean;
  dailyGoal: number;
  monthlyGoal: number;
  boundaryHour: number;
}

/**
 * 使うものを、必要な分だけの形で受け取る。
 *
 * **一度きりを試験で確かめるため。** 本物のファイルや設定を要求すると、
 * 「保存を何度くり返しても一度だけ」を確かめられない。
 */
export interface CelebrationDeps {
  memento: {
    get<T>(key: string, fallback: T): T;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
  };
  works(): readonly WorkEntry[];
  /** その作品の全端末の執筆量の記録 */
  loadStats(work: WorkEntry): Promise<DeviceWritingStats[]>;
  /** 作品の達成の記録。**壊れていれば例外**（直して上書きしない） */
  loadWorkLog(work: WorkEntry): Promise<Achievement[]>;
  appendWorkLog(work: WorkEntry, added: readonly Achievement[]): Promise<void>;
  readGoals(work: WorkEntry): Promise<WorkGoals>;
  settings(): CelebrationSettings;
  now?(): Date;
}

/** 執筆統計へ送る祝いの中身 */
export interface CelebrationPayload {
  size: CelebrationSize;
  /** 画面に出す「◯◯を達成」の行 */
  lines: string[];
  /** 見せ終えたら返してもらう鍵 */
  ids: string[];
}

export class CelebrationService {
  constructor(private readonly deps: CelebrationDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private today(): string {
    return statsDayKey(this.now(), this.deps.settings().boundaryHour);
  }

  private globalRecords(): Achievement[] {
    return toAchievements(this.deps.memento.get<unknown>(GLOBAL_KEY, []));
  }

  private shown(): Set<string> {
    const raw = this.deps.memento.get<unknown>(SHOWN_KEY, []);
    return new Set(
      Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []
    );
  }

  /**
   * 保存を記録し終えたところで呼ぶ。新しく届いた目標を返す（無ければ空）。
   *
   * **失敗しても保存の流れを止めない。** 祝えないだけで原稿は無事なので、
   * ログにだけ残す。
   */
  async afterSave(
    work: WorkEntry,
    outcome: RecordOutcome
  ): Promise<Achievement[]> {
    const settings = this.deps.settings();
    if (!settings.enabled || !outcome.wrote) return [];

    try {
      const at = this.now();
      const day = statsDayKey(at, settings.boundaryHour);
      const global = this.globalRecords();
      const known = new Set(global.map((entry) => entry.id));

      /*
        **もう祝った目標のために、全作品の記録を読まない。** 1日の目標に
        届いたあとも作者は書き続け、保存のたびにここへ来る。届いたかを見る
        必要がまだある目標だけ、合計を出す。
      */
      const needDaily =
        settings.dailyGoal > 0 &&
        !known.has(dailyAchievementId(day, Math.floor(settings.dailyGoal)));
      const needMonthly =
        settings.monthlyGoal > 0 &&
        !known.has(
          monthlyAchievementId(monthKey(day), Math.floor(settings.monthlyGoal))
        );
      const totals =
        needDaily || needMonthly ? await this.allWorksTotals(day) : undefined;

      // 作品の記録が読めなければ、作品の目標は見ない（読めないまま書かない）
      let workLog: Achievement[] | undefined;
      try {
        workLog = await this.deps.loadWorkLog(work);
      } catch (error) {
        useLogFile(work.folderPath);
        logFailure("達成の記録を読めませんでした（作品の目標は祝いません）", {
          作品: work.title,
          詳細: error instanceof Error ? error.message : String(error),
        });
      }
      for (const entry of workLog ?? []) known.add(entry.id);

      const goals = workLog ? await this.deps.readGoals(work) : undefined;
      const found = judgeAchievements({
        at,
        day,
        wrote: outcome.wrote,
        dailyGoal: needDaily ? settings.dailyGoal : 0,
        todayTotal: totals?.today,
        monthlyGoal: needMonthly ? settings.monthlyGoal : 0,
        monthTotal: totals?.month,
        work: goals
          ? { id: work.id, title: work.title, goals, written: outcome.written }
          : undefined,
        known,
      });
      if (found.length === 0) return [];

      const globalFound = found.filter((entry) => entry.workId === undefined);
      const workFound = found.filter((entry) => entry.workId !== undefined);
      const recorded: Achievement[] = [];

      if (globalFound.length > 0) {
        await this.deps.memento.update(
          GLOBAL_KEY,
          appendAchievements(global, globalFound)
        );
        recorded.push(...globalFound);
      }
      if (workFound.length > 0) {
        try {
          await this.deps.appendWorkLog(work, workFound);
          recorded.push(...workFound);
        } catch (error) {
          /*
            **書けなかった達成は祝わない。** 記録に残らないまま祝うと、
            次の保存でもう一度届いたことになり、一度きりが崩れる。
            書けるようになった次の保存で、改めて祝う。
          */
          useLogFile(work.folderPath);
          logFailure("達成の記録を書けませんでした", {
            作品: work.title,
            詳細: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return recorded;
    } catch (error) {
      useLogFile(work.folderPath);
      logFailure("目標の達成の判定に失敗", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * 全作品を合わせた今日と今月の字数。
   *
   * **1日・1月の目標は全作品で共有**なので、届いたかは合計で見る
   * （全作品の執筆統計と同じ見方。設計書6.3.5）。1作品だけで見ると、
   * 2作品を並行して書いた日に、合わせて届いても祝えない。
   */
  private async allWorksTotals(
    day: string
  ): Promise<{ today: number; month: number }> {
    const sets = (
      await Promise.all(
        this.deps.works().map((work) =>
          // 読めない作品は数えないだけにする（その作品のせいで祝いを止めない）
          this.deps.loadStats(work).catch(() => [] as DeviceWritingStats[])
        )
      )
    ).flat();
    const days = mergeDailyStats(sets);
    const month = monthKey(day);
    return {
      today: sumRange(days, day, day).net,
      month: sumRange(days, `${month}-01`, `${month}-31`).net,
    };
  }

  /**
   * 執筆統計に出す達成の記録。作品を渡せばその作品の分も、
   * 渡さなければ（全作品の統計）1日・1月の分だけ。古い順。
   */
  async recordsFor(work: WorkEntry | undefined): Promise<Achievement[]> {
    const records = [...this.globalRecords()];
    if (work) {
      try {
        records.push(...(await this.deps.loadWorkLog(work)));
      } catch {
        // 読めなければ出さない。読めないことは afterSave がログに残している
      }
    }
    return records.sort((left, right) => left.at.localeCompare(right.at));
  }

  /** 執筆統計でまだ見せていない祝い。無ければ undefined */
  async pendingFor(
    work: WorkEntry | undefined
  ): Promise<CelebrationPayload | undefined> {
    if (!this.deps.settings().enabled) return undefined;
    const pending = pendingCelebrations(
      await this.recordsFor(work),
      this.shown(),
      this.today()
    );
    const size = celebrationSize(pending.map((entry) => entry.kind));
    if (!size) return undefined;
    return {
      size,
      lines: pending.map((entry) => `${describeAchievement(entry)}を達成`),
      ids: pending.map((entry) => entry.id),
    };
  }

  /** 見せ終えた祝いに印を付ける（二度は上げない） */
  async markShown(ids: readonly string[]): Promise<void> {
    const current = [...this.shown()];
    const seen = new Set(current);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      current.push(id);
    }
    await this.deps.memento.update(
      SHOWN_KEY,
      current.length > SHOWN_LIMIT ? current.slice(-SHOWN_LIMIT) : current
    );
  }

  /** 原稿エディターの下の欄に出す一言。今日の達成が無ければ undefined */
  async cheerFor(work: WorkEntry): Promise<string | undefined> {
    if (!this.deps.settings().enabled) return undefined;
    return footCheer(await this.recordsFor(work), this.today(), work.id);
  }
}

/**
 * 執筆統計の2つの画面（作品ごと・全作品）が使う口。
 *
 * **拡張機能の起動時に1度だけつなぐ。** 画面を開く関数は呼び出し元が多く
 * （保存・取り込み・メニュー）、そのすべてへ係を引き回すと配線を忘れる
 * 入口が必ず出る。つながっていなければ、画面は祝わずに開くだけにする。
 */
let connected: CelebrationService | undefined;

export function connectCelebrations(service: CelebrationService | undefined): void {
  connected = service;
}

/** 画面の「達成の記録」に出す行（新しい順） */
export interface AchievementRow {
  day: string;
  kind: Achievement["kind"];
  text: string;
}

/** 画面に出す行の上限。古いものまで並べても読まない */
const ROW_LIMIT = 30;

export async function achievementRowsFor(
  work: WorkEntry | undefined
): Promise<AchievementRow[]> {
  if (!connected) return [];
  const records = await connected.recordsFor(work);
  return records
    .slice(-ROW_LIMIT)
    .reverse()
    .map((entry) => ({
      day: entry.day,
      kind: entry.kind,
      text: describeAchievement(entry),
    }));
}

/**
 * まだ見せていない祝いを画面へ送る。
 *
 * **画面が見えているときだけ送る。** 裏に回っているタブで風船を上げても
 * 誰も見ていない。見えるようになったとき（`onDidChangeViewState`）に
 * 改めて呼ぶ。見せ終えたかは画面から `celebrated` で返してもらう——
 * 送っただけで「見せた」ことにすると、描く前に閉じたときに祝いが消える。
 */
export async function offerCelebration(
  panel: vscode.WebviewPanel,
  work: WorkEntry | undefined
): Promise<void> {
  if (!connected || !panel.visible) return;
  try {
    const payload = await connected.pendingFor(work);
    if (payload) await panel.webview.postMessage({ type: "celebrate", payload });
  } catch (error) {
    logFailure("執筆統計の祝い", {
      詳細: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 画面から「見せ終えた」が届いたら印を付ける。扱ったら true */
export async function acceptCelebrated(message: unknown): Promise<boolean> {
  const parsed = message as { type?: unknown; ids?: unknown };
  if (parsed?.type !== "celebrated") return false;
  if (!connected || !Array.isArray(parsed.ids)) return true;
  // 画面から届いた値は、文字列の鍵だけを受け取る
  const ids = parsed.ids.filter((id): id is string => typeof id === "string");
  await connected.markShown(ids);
  return true;
}

/** 本物の保存先と設定で組み立てる */
export function createCelebrationService(options: {
  globalState: vscode.Memento;
  works: () => readonly WorkEntry[];
  deviceId: string;
  settings: () => Omit<CelebrationSettings, "enabled">;
}): CelebrationService {
  return new CelebrationService({
    memento: options.globalState,
    works: options.works,
    loadStats: (work) => new WritingStatsStore(work, options.deviceId).loadAll(),
    loadWorkLog: (work) => new AchievementStore(work).load(),
    appendWorkLog: (work, added) => new AchievementStore(work).append(added),
    readGoals: (work) => readWorkGoalsOrEmpty(work),
    settings: () => ({
      ...options.settings(),
      enabled: vscode.workspace
        .getConfiguration("novelai")
        .get<boolean>("celebrations.enabled", true),
    }),
  });
}
