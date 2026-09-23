import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { WorkRegistry } from "../core/workRegistry";
import { readWorkConfig } from "../core/workRegistry";
import { ScheduleStore } from "../core/scheduleStore";
import { readWorkGoalsOrEmpty } from "../core/workGoalsStore";
import {
  buildIcs,
  collectMilestones,
  ICS_IMPORT_HINT,
  workCalendarKey,
  type CalendarMilestone,
} from "../core/scheduleMilestones";
import { atomicWriteFile } from "../core/atomicWrite";
import { isWebRuntime } from "../core/runtime";
import { logFailure, useLogFile } from "../core/logger";
import { globalStorageRoot } from "./globalStoragePath";
import { goalsContestOf } from "./scheduleData";

/**
 * 大きなマイルストーンを `.ics`（iCalendar）へ書き出す（設計書6.111.15）。
 *
 * 作者の裁定（2026-09-23）：「基本は推奨（.ics の書き出し）で、外部AI利用時はそのまま連携可」。
 * **押したときだけ**書き出す。Google カレンダーへは作者が「インポート」で取り込む
 * （こちらから Google へはつながない）。
 *
 * ## 置き場は作品の外
 *
 * 既定は拡張機能の保管庫。作者が選べば別の場所でもよいが、**作品のフォルダーの中は断る**
 * ——作品の git に載って機器間を行き来し、しかも日付を直すたびに差分が出るため。
 * 前に書き出した場所を覚えておき、次はそこを出す（書き出し直し→取り込み直しを楽に）。
 */

const LAST_ICS_KEY = "novelai.schedule.lastIcsPath";
const DEFAULT_ICS_NAME = "小説のスケジュール.ics";

export async function exportScheduleIcs(
  context: vscode.ExtensionContext,
  registry: WorkRegistry
): Promise<void> {
  const works = registry.list();
  if (works.length === 0) {
    void vscode.window.showInformationMessage("作品が登録されていません。");
    return;
  }

  const milestones: CalendarMilestone[] = [];
  const unreadable: string[] = [];
  const now = new Date();
  for (const work of works) {
    try {
      const file = await new ScheduleStore(work).load();
      const goals = await readWorkGoalsOrEmpty(work);
      const config = await readWorkConfig(work);
      milestones.push(
        ...collectMilestones({
          workKey: workCalendarKey(config?.createdAt, paths.basename(work.folderPath)),
          workTitle: work.title,
          file,
          goalsContest: goalsContestOf(goals),
          now: now.toISOString(),
        })
      );
    } catch (error) {
      // 読めない作品は飛ばす（直さない）。飛ばしたことは知らせる
      unreadable.push(work.title);
      useLogFile(work.folderPath);
      logFailure("スケジュール：カレンダーへの書き出しで読めなかった", {
        work: work.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const skippedNote = unreadable.length
    ? `（読めなかった作品：${unreadable.join("・")}。スケジュールの画面で理由を確かめられます）`
    : "";
  if (milestones.length === 0) {
    void vscode.window.showInformationMessage(
      `書き出す予定がありません。締切・発売日・連載開始日か、段に手で入れた期日があると書き出せます${skippedNote}。`
    );
    return;
  }

  const remembered = context.globalState.get<string>(LAST_ICS_KEY);
  const defaultPath = remembered ?? paths.join(globalStorageRoot(context), DEFAULT_ICS_NAME);
  const picked = await vscode.window.showSaveDialog({
    title: `カレンダーへ書き出す（${milestones.length}件の予定）`,
    defaultUri: paths.toUri(defaultPath),
    filters: { iCalendar: ["ics"] },
    saveLabel: "書き出す",
  });
  if (!picked) return;
  const target = paths.fromUri(picked);
  const inside = works.find(
    (work) => paths.isPathInside(work.folderPath, target) || paths.isSameFolder(work.folderPath, target)
  );
  if (inside) {
    void vscode.window.showWarningMessage(
      `「${inside.title}」のフォルダーの中には書き出しません（作品と一緒に同期され、日付を直すたびに差分が出るため）。作品の外の場所を選んでください。`
    );
    return;
  }

  await vscode.workspace.fs.createDirectory(paths.toUri(paths.dirname(target)));
  // 書き出した .ics は作者のデータではなく、いつでも作り直せる。上書きの経路で書く
  await atomicWriteFile(target, new TextEncoder().encode(buildIcs(milestones, now)));
  await context.globalState.update(LAST_ICS_KEY, target);

  const reveal = "フォルダーを開く";
  const answer = await vscode.window.showInformationMessage(
    `${milestones.length}件の予定を書き出しました：${paths.basename(target)}${skippedNote}。${ICS_IMPORT_HINT}`,
    ...(isWebRuntime() ? [] : [reveal])
  );
  if (answer === reveal) {
    await vscode.commands.executeCommand("revealFileInOS", picked);
  }
}
