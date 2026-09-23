import fs from "node:fs";
import nodePath from "node:path";
import { z } from "zod";
import {
  AIWRITER_DIR,
  CONFIG_FILE,
  DEFAULT_SETTINGS_DIR,
} from "../../models/types";
import { parseScheduleFile, SCHEDULE_FILE, type ScheduleFile } from "../../models/schedule";
import { parseWorkGoals, WORK_GOALS_FILE } from "../../models/workGoals";
import { targetCharsOf } from "../../core/contestProgress";
import {
  collectMilestones,
  ICS_IMPORT_HINT,
  workCalendarKey,
  type CalendarMilestone,
} from "../../core/scheduleMilestones";
import {
  externalAccessDeniedMessage,
  isToolAllowed,
} from "../../core/externalAccessPermission";
import { getExternalClientName, recordExternalAccess } from "./accessLog";
import { readExternalAccessPermission } from "./permission";
import { McpToolError } from "./shared";

/**
 * 全作品の大きなマイルストーンを返す（設計書6.111.15）。**読むだけ。**
 *
 * 作者の裁定（2026-09-23）：「基本は推奨（.ics の書き出し）で、外部AI利用時はそのまま連携可」。
 * 外部AI（Claude など）が、**自分の Google カレンダー連携で**書き込めるように、
 * 拡張機能の .ics 書き出しと**同じ UID・日付・タイトル**を返す（`core/scheduleMilestones.ts`
 * の同じ関数を通す）。カレンダーへ書くのは呼び出し元で、ここは何も書かない。
 *
 * ## 作品ごとに許可を確かめる
 *
 * 1回の呼び出しで複数の作品を読むので、転送層の1か所の確かめ（`folder` を1つ見る）では
 * 足りない。**作品ごとに**この道具の許可を確かめ、**許可の無い作品は出さない**
 * （名前も日付も返さない。断ったことだけ、フォルダーと道順を返す）。断った作品には
 * ノックを残す——次に VS Code でその作品を開いたときに、許可するか訊かれる（6.87.14）。
 *
 * ## 作品の一覧は呼び出し元が渡す
 *
 * 作品の登録簿は VS Code の中（`globalState`）にあり、この束からは読めない。
 * 作品フォルダーか、書庫のフォルダー（直下に作品が並ぶ）を渡してもらう。
 */

export const SCHEDULE_MILESTONES_TOOL = "schedule.milestones";

export const SCHEDULE_MILESTONES_INPUT = {
  folders: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe(
      "作品フォルダーか書庫のフォルダー（直下に作品が並ぶもの）の場所。いくつでも。" +
        "書庫を渡すと、その中の作品を全部見ます"
    ),
};

/** 1つの書庫から見る作品の上限（うっかり大きなフォルダーを渡したときに走り回らない） */
const MAX_WORKS = 200;

export interface ScheduleMilestonesResult {
  milestones: Array<CalendarMilestone & { folder: string }>;
  /** 許可が無いので出さなかった作品（中身は返さない） */
  denied: Array<{ folder: string; reason: string }>;
  /** 読めなかった作品（壊れた JSON など。直さない） */
  unreadable: Array<{ folder: string; reason: string }>;
  /** 使い方の断り */
  note: string;
}

export function scheduleMilestones(input: { folders: string[] }): ScheduleMilestonesResult {
  const works = worksOf(input.folders);
  if (works.length === 0) {
    throw new McpToolError(
      "作品が見つかりませんでした。作品フォルダー（.aiwriter/config.json のあるフォルダー）か、" +
        "その親の書庫のフォルダーを渡してください。"
    );
  }
  const client = getExternalClientName();
  const result: ScheduleMilestonesResult = {
    milestones: [],
    denied: [],
    unreadable: [],
    note:
      "締切・発売日・連載開始日と、作者が段に手で入れた期日だけです（逆算した途中の日付は入れていません）。" +
      "終日の予定として、uid を予定の識別子に使ってください——日付が変わっても uid は同じなので、" +
      "同じ uid の予定を書き換えれば二重になりません。拡張機能の「カレンダーへ書き出す」（.ics）も同じ uid です。" +
      ICS_IMPORT_HINT,
  };

  for (const folder of works) {
    const permission = readExternalAccessPermission(folder);
    if (!isToolAllowed(permission, client, SCHEDULE_MILESTONES_TOOL)) {
      // **ノックを残す**（その作品を開いたときに、許可するか訊かれる）
      recordExternalAccess({ tool: SCHEDULE_MILESTONES_TOOL, args: { folder }, ok: false, denied: true });
      result.denied.push({
        folder,
        reason: externalAccessDeniedMessage({ client, tool: SCHEDULE_MILESTONES_TOOL, legacy: permission.legacy }),
      });
      continue;
    }
    try {
      const found = readWorkMilestones(folder);
      result.milestones.push(...found.map((milestone) => ({ ...milestone, folder })));
      recordExternalAccess({ tool: SCHEDULE_MILESTONES_TOOL, args: { folder }, ok: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.unreadable.push({ folder, reason });
      recordExternalAccess({ tool: SCHEDULE_MILESTONES_TOOL, args: { folder }, ok: false, failure: reason });
    }
  }
  result.milestones.sort((a, b) => (a.date === b.date ? a.uid.localeCompare(b.uid) : a.date < b.date ? -1 : 1));
  return result;
}

/** 渡された場所から作品フォルダーを集める（作品そのもの・書庫の直下）。重ねない */
function worksOf(folders: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (folder: string) => {
    const key = process.platform === "win32" ? folder.toLowerCase() : folder;
    if (seen.has(key) || out.length >= MAX_WORKS) return;
    seen.add(key);
    out.push(folder);
  };
  for (const raw of folders) {
    if (!raw.trim()) continue;
    const folder = nodePath.resolve(raw.trim());
    if (isWorkFolder(folder)) {
      add(folder);
      continue;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = nodePath.join(folder, entry.name);
      if (isWorkFolder(child)) add(child);
    }
  }
  return out;
}

function isWorkFolder(folder: string): boolean {
  return fs.existsSync(nodePath.join(folder, AIWRITER_DIR, CONFIG_FILE));
}

/**
 * 1つの作品のマイルストーン。**壊れた JSON は直さずに投げる**（規則2）。
 * スケジュールが無い作品は、応募先があれば締切だけ（画面と同じ）。
 */
function readWorkMilestones(folder: string): CalendarMilestone[] {
  const config = readJson(nodePath.join(folder, AIWRITER_DIR, CONFIG_FILE), "作品設定") as Record<string, unknown> | null;
  const settingsDir =
    config && typeof config.settingsDir === "string" && config.settingsDir.trim()
      ? config.settingsDir.trim()
      : DEFAULT_SETTINGS_DIR;
  const scheduleRaw = readJson(nodePath.join(folder, settingsDir, SCHEDULE_FILE), SCHEDULE_FILE);
  let file: ScheduleFile = { schemaVersion: "1", schedules: [] };
  if (scheduleRaw !== null) {
    try {
      file = parseScheduleFile(scheduleRaw);
    } catch (error) {
      throw new McpToolError(`${SCHEDULE_FILE} を読めませんでした（直していません）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const goalsRaw = readJson(nodePath.join(folder, AIWRITER_DIR, WORK_GOALS_FILE), WORK_GOALS_FILE);
  let goalsContest = null;
  if (goalsRaw !== null) {
    try {
      const goals = parseWorkGoals(goalsRaw);
      goalsContest = goals.contest
        ? { name: goals.contest.name, deadline: goals.contest.deadline, targetChars: targetCharsOf(goals.contest) }
        : null;
    } catch (error) {
      throw new McpToolError(`${WORK_GOALS_FILE} を読めませんでした（直していません）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const folderName = nodePath.basename(folder);
  const workTitle =
    config && typeof config.workTitle === "string" && config.workTitle.trim() ? config.workTitle.trim() : folderName;
  const createdAt = config && typeof config.createdAt === "string" ? config.createdAt : null;
  return collectMilestones({
    workKey: workCalendarKey(createdAt, folderName),
    workTitle,
    file,
    goalsContest,
    now: new Date().toISOString(),
  });
}

/** 無ければ null。壊れていれば投げる */
function readJson(target: string, label: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new McpToolError(`${label} が JSON として読めませんでした（直していません）。`);
  }
}
