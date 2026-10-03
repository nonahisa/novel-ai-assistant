import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "../core/workRegistry";
import { pruneLogText } from "../core/logRetention";
import { libraryLogCandidates } from "../core/syncTarget";
import { statsDayKey } from "../core/writingStats";

/**
 * ログの古い行を落とす（設計書8.3）。
 *
 * 作者の要望。**既定は7日。**
 *
 * **起動のときに1回だけ走らせる。** 書き込みのたびに全体を読み直すと、
 * 抽出のように何十回も書く処理が遅くなる。1日1回でも用は足りる。
 *
 * **失敗しても何も言わない。** ログの整理ができないことより、
 * それを知らせるダイアログのほうが作者の邪魔になる。
 */

/** `.aiwriter/logs/` に置いている、日時つきのログ */
const LOG_FILES = ["actions.log", "ai_actions.log", "chat.md"];

export function logRetentionDays(): number {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<number>("logs.retentionDays", 7);
}

/**
 * 登録している作品すべてのログを整理する。
 *
 * @returns 消した行数（試験と記録のため）
 */
export async function pruneAllLogs(works: readonly WorkEntry[]): Promise<number> {
  const days = logRetentionDays();
  if (days <= 0) return 0;

  const today = statsDayKey(new Date(), 0);
  let removed = 0;
  for (const work of works) {
    removed += await pruneLogFolder(
      path.join(workPaths(work).aiwriter, "logs"),
      LOG_FILES,
      days,
      today
    );
  }
  // **書庫のログ**（設計書5.7.9）。書庫の直下に置くのは同期の記録だけ
  for (const root of libraryLogCandidates(works)) {
    removed += await pruneLogFolder(
      path.join(root, ".aiwriter", "logs"),
      LIBRARY_LOG_FILES,
      days,
      today
    );
  }
  return removed;
}

/** 書庫の直下の `.aiwriter/logs/` に置いている、日時つきのログ */
const LIBRARY_LOG_FILES = ["actions.log"];

async function pruneLogFolder(
  dir: string,
  fileNames: readonly string[],
  days: number,
  today: string
): Promise<number> {
  let removed = 0;

  for (const fileName of fileNames) {
    const uri = path.toUri(path.join(dir, fileName));
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const result = pruneLogText(
        new TextDecoder().decode(bytes),
        days,
        today
      );
      if (!result.changed) continue;
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(result.text)
      );
      removed += result.removed;
    } catch {
      // 無い・読めないログは飛ばす。整理できないことを知らせる必要はない
    }
  }
  return removed;
}
