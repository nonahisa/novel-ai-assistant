import * as vscode from "vscode";
import type { WorkRegistry } from "../core/workRegistry";
import { collectScheduleNotices, scheduleNoticeText } from "../core/scheduleNotice";
import { logFailure, useLogFile } from "../core/logger";
import { loadScheduleBoard, scheduleToday } from "./scheduleData";

/**
 * スケジュールの知らせ（設計書6.111.9）。**1日1回だけ**、まとめて1つ出す。
 *
 * - 起動の少しあと（20秒。起動の重い時間帯に作品を走査しない）と、日が替わったとき
 *   （30分ごとに日付を見る）に確かめる
 * - 出した日は拡張機能の記憶（`globalState`。ウィンドウをまたいで共有）に残す。
 *   **ウィンドウを2つ開いていても、同じ日に2度出さない**
 * - 設定 `novelai.schedule.notify` で切れる
 */

const LAST_NOTICE_KEY = "novelai.schedule.lastNoticeDay";
const STARTUP_DELAY_MS = 20_000;
const DAY_CHECK_INTERVAL_MS = 30 * 60_000;

export function startScheduleNotices(
  context: vscode.ExtensionContext,
  registry: WorkRegistry,
  deviceId: string
): void {
  let checkedDay: string | null = null;
  const check = async () => {
    const today = scheduleToday();
    if (checkedDay === today) return;
    checkedDay = today;
    if (!vscode.workspace.getConfiguration("novelai").get<boolean>("schedule.notify", true)) return;
    if (context.globalState.get<string>(LAST_NOTICE_KEY) === today) return;
    try {
      const board = await loadScheduleBoard(registry, deviceId, { showFinished: false });
      const text = scheduleNoticeText(collectScheduleNotices(board.columns, board.today));
      // 何も無い日も「確かめた」と残す（あとから開いたウィンドウが走査し直さない）
      await context.globalState.update(LAST_NOTICE_KEY, today);
      if (!text) return;
      const open = "スケジュールを開く";
      const answer = await vscode.window.showInformationMessage(text, open);
      if (answer === open) await vscode.commands.executeCommand("novelai.openSchedule");
    } catch (error) {
      // 知らせは補助。失敗しても作業は止めない（記録だけ残す）
      // 作品をまたぐ確かめなので、作品のログではなく拡張機能のログへ
      useLogFile(undefined);
      logFailure("スケジュール：知らせの確かめに失敗した", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const startup = setTimeout(() => void check(), STARTUP_DELAY_MS);
  const interval = setInterval(() => void check(), DAY_CHECK_INTERVAL_MS);
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(startup);
      clearInterval(interval);
    },
  });
}
