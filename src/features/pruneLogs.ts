import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import { workPaths } from "../core/workRegistry";
import { pruneLogText } from "../core/logRetention";
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
    removed += await pruneWorkLogs(work, days, today);
  }
  return removed;
}

async function pruneWorkLogs(
  work: WorkEntry,
  days: number,
  today: string
): Promise<number> {
  const dir = path.join(workPaths(work).aiwriter, "logs");
  let removed = 0;

  for (const fileName of LOG_FILES) {
    const uri = vscode.Uri.file(path.join(dir, fileName));
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
