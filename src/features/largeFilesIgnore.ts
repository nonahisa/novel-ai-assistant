import * as vscode from "vscode";
import { ignoreRuleFor, type LargeFile } from "../core/gitLargeFiles";
import { appendIgnoreRules } from "../core/workRegistry";
import { logFailure, logStep } from "../core/logger";
import type { WorkEntry } from "../models/types";
import { useSyncLog } from "./syncLog";

/**
 * GitHub に送れない大きさのファイルを記録から外すボタン（設計書5.5.21）。
 * 「すべて同期」の報告と、単独の同期の「取り込む前の記録」が同じものを出す
 */
export const IGNORE_LARGE_FILES_LABEL = ".gitignore に足す";

/**
 * ［.gitignore に足す］を押したときだけ、置き場の根の .gitignore の末尾へ道を足す。
 *
 * **ファイルは動かさない・消さない。** 作者が書いた行は変えない（`appendIgnoreRules`）。
 * 足したあと、もう一度同期すれば、そのファイルを除いて記録される
 */
export async function ignoreLargeFiles(
  root: string,
  files: readonly LargeFile[],
  works: readonly WorkEntry[]
): Promise<void> {
  // 押されるのは報告のあとなので、ログの向きを置き場へ向け直す（書庫なら書庫のログ。設計書5.7.9）
  await useSyncLog(root, works);
  try {
    await appendIgnoreRules(
      root,
      files.map((one) => ignoreRuleFor(one.path))
    );
    logStep(
      `GitHub に送れない大きさのファイルを .gitignore に足した（${root}／${files
        .map((one) => one.path)
        .join("、")}）`
    );
    void vscode.window.showInformationMessage(
      `${files.length}件を .gitignore に足しました。もう一度同期してください。`
    );
  } catch (error) {
    logFailure(".gitignore に足せなかった", {
      置き場: root,
      詳細: error instanceof Error ? error.message : String(error),
    });
    void vscode.window.showWarningMessage(
      ".gitignore に足せませんでした（詳しくはログにあります）。"
    );
  }
}
