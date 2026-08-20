import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import { workPaths } from "../core/workRegistry";
import { scanWork } from "../core/scanner";
import {
  changedSince,
  describeScope,
  shouldAskScope,
  type ScopeChoice,
} from "../core/typoCheckScope";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { atomicWriteFile } from "../core/atomicWrite";

/**
 * 誤字脱字の対象範囲（設計書6.8.7）。
 *
 * **前回の検知の時刻を覚えて、そのあとに書いた話だけを対象にできる。**
 *
 * 時刻は `.aiwriter/cache/` に置く。**同期しない。**
 * 「いつ検知したか」は環境ごとの話で、別のパソコンへ持っていく意味がない。
 * `cache/` は `.gitignore` で除かれている。
 */

const FILE_NAME = "typo_last_check.json";

function filePath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, "cache", FILE_NAME);
}

/** 前回の検知の時刻。読めなければ undefined（＝一度も検知していない扱い） */
export async function readLastCheck(
  work: WorkEntry
): Promise<number | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.file(filePath(work))
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const at =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { checkedAt?: unknown }).checkedAt
        : undefined;
    return typeof at === "number" && Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 検知した時刻を記録する。
 *
 * **失敗しても呼び出し側を止めない。** 記録できないと次回に絞り込めない
 * だけで、検知そのものは終わっている。
 */
export async function recordCheck(work: WorkEntry): Promise<void> {
  const target = filePath(work);
  try {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(target))
    );
    await atomicWriteFile(
      target,
      new TextEncoder().encode(
        JSON.stringify({ checkedAt: Date.now() }, null, 2) + "\n"
      )
    );
  } catch {
    // 絞り込めなくなるだけ
  }
}

/**
 * 対象範囲を決める。
 *
 * **聞く意味があるときだけ聞く。** 一度も検知していない・全部が対象になる・
 * 1件も無い、のいずれでも聞かない。
 *
 * @returns 取りやめなら undefined
 */
export async function chooseScope(
  work: WorkEntry
): Promise<ScopeChoice | undefined> {
  const lastCheckedAt = await readLastCheck(work);
  if (lastCheckedAt === undefined) return { kind: "all" };

  let candidates: Array<{ filePath: string; modifiedAt: number | undefined }>;
  try {
    const scanned = await scanWork(work);
    candidates = await Promise.all(
      scanned.episodes.map(async (episode) => ({
        filePath: episode.filePath,
        modifiedAt: await modifiedAt(episode.filePath),
      }))
    );
  } catch {
    // 走査できないなら絞らない
    return { kind: "all" };
  }

  const changed = changedSince(candidates, lastCheckedAt);
  if (!shouldAskScope(candidates.length, changed.length, lastCheckedAt)) {
    // **1件も無いときは、その旨を伝えて止める。**
    // 黙って全体を見ると、作者は「差分だけのはずが全部出た」と思う
    if (changed.length === 0 && candidates.length > 0) {
      const answer = await vscode.window.showInformationMessage(
        "前回の検知のあとに書いた話はありません。",
        "作品全体を見る"
      );
      return answer === "作品全体を見る" ? { kind: "all" } : undefined;
    }
    return { kind: "all" };
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(diff) 前回から書いた分だけ（${changed.length}話）`,
        detail:
          "前回の検知のあとに書いた話だけを見ます。一覧が短くなり、待ち時間も減ります。",
        // `kind` は QuickPickItem が区切り線に使う予約名。別名にする
        scope: "changed" as const,
      },
      {
        label: `$(book) 作品全体（${candidates.length}話）`,
        detail:
          "すべての話を見ます。AIは呼び直しません（変わっていない話は前の結果を使います）。",
        scope: "all" as const,
      },
      cancelItem(),
    ],
    {
      title: "どこまで見ますか",
      placeHolder: describeScope(candidates.length, changed.length),
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;

  return "scope" in picked && picked.scope === "changed"
    ? { kind: "changed", filePaths: changed }
    : { kind: "all" };
}

async function modifiedAt(file: string): Promise<number | undefined> {
  try {
    return (await vscode.workspace.fs.stat(vscode.Uri.file(file))).mtime;
  } catch {
    return undefined;
  }
}
