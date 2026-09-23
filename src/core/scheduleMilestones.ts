import {
  MILESTONE_LABELS,
  SCHEDULE_KIND_LABELS,
  type ScheduleFile,
  type ScheduleKind,
} from "../models/schedule";
import { addDays } from "./writingStats";
import { sha1Text } from "./hash";
import { schedulesWithGoals, type GoalsContestRef } from "./schedulePlan";

/**
 * カレンダーへ出す「大きなマイルストーン」（設計書6.111.15）。
 *
 * 作者の裁定（2026-09-23）：「基本は推奨（.ics の書き出し）で、外部AI利用時はそのまま連携可」。
 * 書き出すのは**締切・発売日・連載開始日と、作者が手で入れた期日**（出版社から来た
 * 初校の戻しなど）だけ。逆算した段の途中の日付は入れない——書き出したあとに作者が
 * 段を直すと、カレンダーの側だけ古い日付が残るため。
 *
 * ## UID（同じ予定は同じ UID）
 *
 * 日付が変わって書き出し直したとき、Google カレンダーの取り込みで**同じ予定として
 * 上書きされる**ように、UID は日付を含めずに作る：
 *
 *     <作品の鍵>-<スケジュールID>-<種類>@novel-ai-assistant
 *
 * - **作品の鍵**は、作品の `.aiwriter/config.json` の作成日時（同期される）から作る
 *   （`workCalendarKey`）。拡張機能の作品の登録ID は機器ごとに違う乱数で、別の機器から
 *   書き出すと別の予定になってしまう。MCP の束も登録簿を読めない
 * - **スケジュールID**は `設定/スケジュール.json` のもの（同期される）
 * - **種類**：`deadline`（締切）・`release`（発売日）・`serial-start`（連載開始）・
 *   `due-<段ID>`（手で入れた期日）
 *
 * MCP の道具（`schedule.milestones`）も、ここと同じ関数で同じ UID を返す。
 *
 * VS Code API には依存しない。
 */

export interface CalendarMilestone {
  readonly uid: string;
  /** `YYYY-MM-DD`（終日の予定） */
  readonly date: string;
  /** 予定のタイトル（「締切：作品名（公募名）」） */
  readonly title: string;
  readonly workTitle: string;
  readonly scheduleName: string;
  readonly scheduleKind: ScheduleKind;
  /** 締切・発売日・連載開始・期日 */
  readonly label: string;
  /** 手で入れた期日のときの段の名前。マイルストーンなら null */
  readonly stepLabel: string | null;
}

const UID_DOMAIN = "novel-ai-assistant";

/** 作品の鍵（UID の頭）。作成日時が無い作品はフォルダーの名前から作る */
export function workCalendarKey(createdAt: string | null | undefined, folderName: string): string {
  const seed = createdAt && createdAt.trim() ? `createdAt:${createdAt.trim()}` : `folder:${folderName}`;
  return `w${sha1Text(seed).slice(0, 12)}`;
}

const MILESTONE_UID_PART: Record<ScheduleKind, string> = {
  contest: "deadline",
  selfPublish: "release",
  publisher: "release",
  webSerial: "serial-start",
};

/** カレンダーの名前に出す呼び名（「連載開始日」は予定の頭には長いので「連載開始」） */
const MILESTONE_TITLE_LABELS: Record<ScheduleKind, string> = {
  contest: MILESTONE_LABELS.contest,
  selfPublish: MILESTONE_LABELS.selfPublish,
  publisher: MILESTONE_LABELS.publisher,
  webSerial: "連載開始",
};

export function milestoneUid(workKey: string, scheduleId: string, part: string): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${safe(workKey)}-${safe(scheduleId)}-${safe(part)}@${UID_DOMAIN}`;
}

export interface MilestoneSource {
  readonly workKey: string;
  readonly workTitle: string;
  readonly file: ScheduleFile;
  readonly goalsContest: GoalsContestRef | null;
  /** 画面の上だけの公募（作品目標設定の応募先）を作るときの時刻 */
  readonly now: string;
}

/** 1つの作品のマイルストーン。日付の順 */
export function collectMilestones(source: MilestoneSource): CalendarMilestone[] {
  const out: CalendarMilestone[] = [];
  for (const { schedule } of schedulesWithGoals(source.file, source.goalsContest, source.now)) {
    const goals = schedule.followsGoals ? source.goalsContest : null;
    // 応募先が外れた公募は、締切を持たない（画面では「外れています」と出す）
    if (schedule.followsGoals && goals === null) continue;
    const name = goals ? goals.name : schedule.name;
    const milestone = goals ? goals.deadline : schedule.milestone;
    const label = MILESTONE_TITLE_LABELS[schedule.kind];
    if (milestone) {
      out.push({
        uid: milestoneUid(source.workKey, schedule.id, MILESTONE_UID_PART[schedule.kind]),
        date: milestone,
        title: `${label}：${source.workTitle}（${name}）`,
        workTitle: source.workTitle,
        scheduleName: name,
        scheduleKind: schedule.kind,
        label,
        stepLabel: null,
      });
    }
    for (const step of schedule.steps) {
      if (!step.due) continue;
      out.push({
        uid: milestoneUid(source.workKey, schedule.id, `due-${step.id}`),
        date: step.due,
        title: `${step.label}の期日：${source.workTitle}（${name}）`,
        workTitle: source.workTitle,
        scheduleName: name,
        scheduleKind: schedule.kind,
        label: "期日",
        stepLabel: step.label,
      });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? a.uid.localeCompare(b.uid) : a.date < b.date ? -1 : 1));
}

/** 取り込み方の案内（1行） */
export const ICS_IMPORT_HINT =
  "Google カレンダーでは「設定 › インポート / エクスポート › インポート」でこのファイルを選ぶと入ります（書き出し直して取り込み直すと、同じ予定は上書きされます）。";

/**
 * iCalendar（RFC 5545）の文を作る。終日の予定（`DTSTART;VALUE=DATE`、終わりは翌日）。
 *
 * - 行の終わりは CRLF。75オクテットを超える行は折り返す（UTF-8 の文字の途中で切らない）
 * - 文字の `\` `;` `,` 改行は逃がす
 * - `SEQUENCE` は書き出した時刻（分）。取り込み直したとき、新しい書き出しのほうが
 *   新しい版だと分かるように
 */
export function buildIcs(milestones: readonly CalendarMilestone[], now: Date): string {
  const stamp = icsTimestamp(now);
  const sequence = Math.floor(now.getTime() / 60_000);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//nonahisa//novel-ai-assistant//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText("小説のスケジュール")}`,
  ];
  for (const milestone of milestones) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${milestone.uid}`,
      `DTSTAMP:${stamp}`,
      `SEQUENCE:${sequence}`,
      `DTSTART;VALUE=DATE:${milestone.date.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${addDays(milestone.date, 1).replace(/-/g, "")}`,
      `SUMMARY:${escapeText(milestone.title)}`,
      `DESCRIPTION:${escapeText(
        `${SCHEDULE_KIND_LABELS[milestone.scheduleKind]}「${milestone.scheduleName}」の${milestone.stepLabel ? `「${milestone.stepLabel}」の期日` : milestone.label}です。` +
          "\n小説執筆のスケジュールから書き出しました。日付を直したら書き出し直して、取り込み直してください。"
      )}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** TEXT の逃がし（RFC 5545 3.3.11） */
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** 75オクテットで折り返す（続きの行は空白1つで始める。文字の途中で切らない） */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  // 1行目は75、続きは先頭の空白を含めて75（中身は74）
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
      limit = 74;
    }
    current += char;
    size += bytes;
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

function icsTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
