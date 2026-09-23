import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { ContestGoal } from "../models/workGoals";
import { scanWork } from "../core/scanner";
import {
  buildContestProgress,
  describeContestProgress,
} from "../core/contestProgress";
import { statsDayKey } from "../core/writingStats";
import { boundaryHour } from "./writingProgress";

/**
 * 応募先を入れた直後に、いまの進み具合を見せる（設計書6.3.6）。
 *
 * 作品目標設定で手で入れたときと、公募の一覧から選んで入れたとき
 * （`contestImport.ts`）の両方から呼ぶ。**写しを作らない**ためにここへ置いた。
 */
export async function reportContest(
  work: WorkEntry,
  contest: ContestGoal
): Promise<void> {
  let written = 0;
  try {
    written = (await scanWork(work)).stats.totals.net;
  } catch {
    // 走査できなくても保存は済んでいる
  }
  const progress = buildContestProgress(
    { schemaVersion: "0.1", perEpisodeChars: null, contest },
    written,
    statsDayKey(new Date(), boundaryHour())
  );
  if (!progress) return;

  const answer = await vscode.window.showInformationMessage(
    describeContestProgress(progress),
    "執筆量を見る"
  );
  if (answer === "執筆量を見る") {
    await vscode.commands.executeCommand("novelai.showWritingStats", {
      type: "work",
      work,
    });
  }
}
