import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import {
  emptyWorkGoals,
  parseWorkGoals,
  WORK_GOALS_FILE,
  WORK_GOALS_SCHEMA_VERSION,
  type WorkGoals,
} from "../models/workGoals";
import { workPaths } from "./workRegistry";
import { atomicWriteFile, createManagedRecoveryPath } from "./atomicWrite";

/**
 * 作品ごとの目標の保存（設計書6.3.6）。
 *
 * `.aiwriter/goals.json` に置く。**環境ごとに分けない。** 実績
 * （`stats/<環境名>.json`）は複数の環境で同時に書くと競合するので分けているが、
 * 目標は作者が決めた1つの狙いで、どの環境から見ても同じである。
 *
 * **壊れたJSONを勝手に直さない。** 読めなければエラーとして返し、
 * 呼び出し側が作者へ伝える。直して上書きすると、作者が書いた値が黙って消える。
 */

/** 読んだ結果を覚える。話ごとの一覧は行ごとに目標を参照する */
const cache = new Map<string, WorkGoals>();

function goalsPath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, WORK_GOALS_FILE);
}

/**
 * 目標を読む。**無ければ空の目標**（決めていない状態）を返す。
 *
 * @throws 壊れたJSONのときだけ。無いことは失敗ではない
 */
export async function readWorkGoals(work: WorkEntry): Promise<WorkGoals> {
  const cached = cache.get(work.id);
  if (cached) return cached;

  let goals: WorkGoals;
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.file(goalsPath(work))
    );
    goals = parseWorkGoals(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    ) {
      goals = emptyWorkGoals();
    } else {
      throw error;
    }
  }

  cache.set(work.id, goals);
  return goals;
}

/** 読めなければ空として扱う。一覧や統計を目標のせいで止めない */
export async function readWorkGoalsOrEmpty(
  work: WorkEntry
): Promise<WorkGoals> {
  try {
    return await readWorkGoals(work);
  } catch {
    return emptyWorkGoals();
  }
}

export async function writeWorkGoals(
  work: WorkEntry,
  goals: WorkGoals
): Promise<void> {
  const target = goalsPath(work);
  const body =
    JSON.stringify(
      { ...goals, schemaVersion: WORK_GOALS_SCHEMA_VERSION },
      null,
      2
    ) + "\n";

  await vscode.workspace.fs.createDirectory(
    vscode.Uri.file(path.dirname(target))
  );

  // 既存ファイルは上書きできない（`atomicWrite.ts`）。
  // 退避してから作り直す
  if (await exists(target)) {
    const recoveryPath = await createManagedRecoveryPath(target);
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
    await atomicWriteFile(recoveryPath, bytes, { mode: "create" });
    await vscode.workspace.fs.delete(vscode.Uri.file(target), {
      useTrash: false,
    });
  }

  await atomicWriteFile(target, new TextEncoder().encode(body), {
    mode: "create",
  });
  cache.set(work.id, goals);
}

export function invalidateWorkGoals(workId?: string): void {
  if (workId) {
    cache.delete(workId);
  } else {
    cache.clear();
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}
