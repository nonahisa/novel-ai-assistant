import * as vscode from "vscode";
import * as path from "./paths";
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
import {
  detectExternalChange,
  externalChangeMessage,
  keepUnsavedCopy,
  snapshotOf,
} from "./readWriteGuard";

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

export class WorkGoalsStoreError extends Error {
  constructor(
    message: string,
    readonly recoveryPaths: string[] = [],
    readonly kind?: "modified_externally"
  ) {
    super(message);
    this.name = "WorkGoalsStoreError";
  }
}

/**
 * 読んだ結果を覚える。話ごとの一覧は行ごとに目標を参照する。
 *
 * **読んだときの控え（中身のハッシュ）も一緒に持つ**（`readWriteGuard.ts`）。
 * 作者が画面に出ている目標を直して保存するとき、その目標を読んでから外（同期・手）で
 * 書き換わっていれば、覚えていた古い目標で上書きしてしまう。書く前に控えと照合する。
 */
const cache = new Map<string, { goals: WorkGoals; snapshot: string | null }>();

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
  if (cached) return cached.goals;

  let goals: WorkGoals;
  let snapshot: string | null;
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(goalsPath(work))
    );
    goals = parseWorkGoals(JSON.parse(new TextDecoder().decode(bytes)));
    snapshot = snapshotOf(bytes);
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    ) {
      goals = emptyWorkGoals();
      snapshot = null;
    } else {
      throw error;
    }
  }

  cache.set(work.id, { goals, snapshot });
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

/**
 * 目標を書く。
 *
 * **退避の前に、読んだときから外で変わっていないかを照合する**（`readWriteGuard.ts`）。
 * 違えば書かずに止め、直そうとした目標を回復先へ控える。**覚えていた目標も捨てる**
 * ——捨てないと次も古い目標を読み、何度やり直しても断り続ける。
 *
 * 読めなかった目標（壊れたJSON。`readWorkGoalsOrEmpty` は空として返す）は覚えて
 * いないので、ここでは「読んでいない」と同じ扱いになり、そこにファイルがあれば止まる
 * ——壊れたファイルを空の目標で塗り替えない。
 */
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
  const encoded = new TextEncoder().encode(body);

  await vscode.workspace.fs.createDirectory(
    path.toUri(path.dirname(target))
  );

  const change = await detectExternalChange(target, cache.get(work.id)?.snapshot);
  if (change) {
    cache.delete(work.id);
    const unsavedCopy = await keepUnsavedCopy(target, encoded);
    throw new WorkGoalsStoreError(
      externalChangeMessage({
        label: "作品の目標",
        fileLabel: `.aiwriter/${WORK_GOALS_FILE}`,
        change,
        unsavedCopy,
      }),
      unsavedCopy ? [target, unsavedCopy] : [target],
      "modified_externally"
    );
  }

  // 既存ファイルは上書きできない（`atomicWrite.ts`）。
  // 退避してから作り直す
  if (await exists(target)) {
    const recoveryPath = await createManagedRecoveryPath(target);
    const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    await atomicWriteFile(recoveryPath, bytes, { mode: "create" });
    await vscode.workspace.fs.delete(path.toUri(target), {
      useTrash: false,
    });
  }

  await atomicWriteFile(target, encoded, {
    mode: "create",
  });
  // 自分で書いた中身で覚え直す。覚え直さないと、続けての保存を外部変更と取り違える
  cache.set(work.id, { goals, snapshot: snapshotOf(encoded) });
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
    await vscode.workspace.fs.stat(path.toUri(filePath));
    return true;
  } catch {
    return false;
  }
}
