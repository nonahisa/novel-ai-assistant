import fs from "node:fs";
import nodePath from "node:path";
import { z } from "zod";
import {
  NOTICE_DEFAULT_LIMIT,
  NOTICE_LOG_DIRECTORY,
  NOTICE_LOG_MAX_ENTRIES,
  parseNoticeLog,
  selectNotices,
  type NoticeLogFile,
  type NoticeView,
} from "../../core/noticeLog";
import { mcpGlobalStorageRoot } from "../globalStorage";
import { McpToolError } from "./shared";
import { mcpMachineName } from "./windows";

/**
 * 拡張機能が出した知らせを読む（MCP の道具 `notices.recent`。作者の承認、2026-09-24）。
 *
 * **読むだけ。** 拡張機能が保管庫へ書いた知らせの記録（`core/noticeLog.ts`）を
 * 絞り込んで返す。記録を消すのも直すのも拡張機能の側で、ここは1バイトも
 * 書かない（`windows.list` と同じ）。
 *
 * **作品を取らない。** 記録にあるのは知らせの文（先頭200字、キーは伏せ字）・
 * 種類・ボタン・時刻・窓だけで、作品フォルダーを1つも開かない。
 * 許可（6.87.10）の対象外で、原稿の出方は `none`。
 *
 * **1つ壊れていても止めない。** 読めなかった記録はファイル名と理由を
 * `unreadable` に添える。
 */

export const NOTICES_RECENT_INPUT = {
  since: z
    .string()
    .optional()
    .describe("この時刻（ISO 8601）より後の知らせだけ。省けば保管期間（7日）ぜんぶ"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(NOTICE_LOG_MAX_ENTRIES)
    .optional()
    .describe(`返す件数の上限（新しい順）。既定は ${NOTICE_DEFAULT_LIMIT}`),
  contains: z
    .string()
    .optional()
    .describe("知らせの文・説明・ボタンの名前に、この文字を含むものだけ"),
  pid: z
    .number()
    .int()
    .optional()
    .describe("この窓（windows.list の pid）の知らせだけ"),
};

export interface NoticesRecentInput {
  since?: string;
  limit?: number;
  contains?: string;
  pid?: number;
}

export interface NoticesRecentResult {
  /** このサーバーが走っている機械の名前（記録は機械ごとの保管庫にある） */
  machineName: string | null;
  /** 記録を探した場所 */
  storage: string | null;
  /** 新しい順 */
  notices: NoticeView[];
  /** 件数の上限で切る前に、絞り込みに合った数 */
  matched: number;
  unreadable: { file: string; reason: string }[];
  note: string;
}

const NOTE =
  "拡張機能が出した知らせ（右下の通知と、画面中央の確認）の記録です。" +
  "message は先頭200字まで（truncated が true なら切っています）、キーらしき文字は伏せています。" +
  "answer が null の知らせは、まだ閉じられていません（右下に残っているか、窓が先に閉じた）。" +
  "answer.choice は押されたボタンの名前で、閉じただけなら null です。" +
  "記録は7日・窓ごとに500件まで。この機械の保管庫にあるので、別の機械の知らせは出ません。";

export function noticesRecent(
  input: NoticesRecentInput = {},
  now: Date = new Date()
): NoticesRecentResult {
  // 読めない時刻を黙って無視すると、絞ったつもりで全部が返る
  if (input.since !== undefined && Number.isNaN(Date.parse(input.since))) {
    throw new McpToolError(
      `since が時刻として読めません（${input.since}）。2026-09-24T10:00:00+09:00 のような ISO 8601 で渡してください。`
    );
  }

  const root = mcpGlobalStorageRoot();
  const machineName = mcpMachineName();
  if (!root) {
    return {
      machineName,
      storage: null,
      notices: [],
      matched: 0,
      unreadable: [],
      note:
        "保管庫の場所が分かりませんでした（束の居場所が読めず、" +
        "NOVELAI_GLOBAL_STORAGE も指定されていません）。" +
        NOTE,
    };
  }

  const directory = nodePath.join(root, ...NOTICE_LOG_DIRECTORY);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    // まだ1つも記録が無い（拡張機能を起動していない・記録しない古い版）。失敗にしない
    return {
      machineName,
      storage: directory,
      notices: [],
      matched: 0,
      unreadable: [],
      note:
        "記録が1つもありません（この機械で拡張機能がまだ起動していないか、" +
        "知らせを記録しない古い版が動いています）。" +
        NOTE,
    };
  }

  const files: NoticeLogFile[] = [];
  const unreadable: { file: string; reason: string }[] = [];
  for (const name of names.sort()) {
    // 書きかけの一時ファイル（`atomicWriteFile` の `.tmp`）は記録ではない
    if (!name.endsWith(".json")) continue;
    let text: string;
    try {
      text = fs.readFileSync(nodePath.join(directory, name), "utf8");
    } catch (error) {
      unreadable.push({
        file: name,
        reason: `読めませんでした: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const log = parseNoticeLog(text);
    if (!log) {
      unreadable.push({ file: name, reason: "記録の形になっていません" });
      continue;
    }
    files.push(log);
  }

  const { notices, matched } = selectNotices(files, input, now);
  return { machineName, storage: directory, notices, matched, unreadable, note: NOTE };
}
