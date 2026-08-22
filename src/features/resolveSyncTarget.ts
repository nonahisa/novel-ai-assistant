import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { readSyncStatus, runGit, type GitCommandRunner } from "../core/git";
import { scanCollection } from "../core/workCollection";
import {
  buildSyncTarget,
  parentFolderOf,
  worksInside,
  type SyncTarget,
} from "../core/syncTarget";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 「どこを1つの置き場（リポジトリ）として扱うか」を決める（設計書5.7.9）。
 *
 * **既定は、複数の作品が1つの置き場に入っている形である**（作者の判断、
 * 2026-08-22）。作品ごとに分けると、別の環境へ移るたびに作品の数だけ
 * 取り寄せることになる。
 *
 * ## すでにリポジトリなら、訊かない
 *
 * `git` が根を教えてくれる。**機械が判断できることを人に聞かない**（5.7.3）。
 * 作品フォルダーの上に `.git` があれば、そこが置き場である。
 *
 * ## まだリポジトリでなければ、まとめるかを訊く
 *
 * 隣に作品が並んでいるなら、**まとめる側を先に出す。** 分ける道も残す
 * ——すでに分けて管理している作者や、編集部へ渡すために切り出す場合がある。
 *
 * 隣に何も無ければ訊かない。選択肢が1つしか無いのに画面を出すのは、
 * 押させるだけの手間である。
 */
export async function resolveSyncTarget(
  work: WorkEntry,
  allWorks: readonly WorkEntry[],
  run: GitCommandRunner = runGit
): Promise<SyncTarget | undefined> {
  // すでにリポジトリの中なら、その根がそのまま置き場になる
  const status = await readSyncStatus(work.folderPath, run);
  if ("root" in status && status.root) {
    return buildSyncTarget(status.root, allWorks);
  }
  if (status.kind === "git_missing") {
    // Gitが無いことは、この先の案内（`nextSetupStep`）が扱う。
    // ここで止めると「導入方法を見る」へ辿り着けない
    return buildSyncTarget(work.folderPath, allWorks);
  }

  const parent = parentFolderOf(work.folderPath);
  if (!parent) return buildSyncTarget(work.folderPath, allWorks);

  const neighbours = await countNeighbouringWorks(parent, work, allWorks);
  if (neighbours === 0) return buildSyncTarget(work.folderPath, allWorks);

  return askHowToGroup(work, parent, neighbours, allWorks);
}

/**
 * 上のフォルダーに、この作品以外の作品がいくつ並んでいるか。
 *
 * **登録済みかどうかは問わない。** まだ登録していない作品も同じ置き場へ
 * 入ることになるので、まとめるかどうかの判断材料になる。
 */
async function countNeighbouringWorks(
  parent: string,
  work: WorkEntry,
  allWorks: readonly WorkEntry[]
): Promise<number> {
  const registered = new Set(
    allWorks.map((entry) => path.normalizeForComparison(entry.folderPath))
  );
  const scan = await scanCollection(parent, (folder) =>
    registered.has(path.normalizeForComparison(folder))
  );
  if (scan.kind !== "collection" && scan.kind !== "work_with_children") {
    return 0;
  }
  const self = path.normalizeForComparison(work.folderPath);
  return scan.works.filter(
    (candidate) => path.normalizeForComparison(candidate.folderPath) !== self
  ).length;
}

/**
 * まとめるか、この作品だけかを訊く。
 *
 * **まとめる側を先に置く。** 既定はそちらで、分けるのは事情があるときである
 * （設計書5.7.9）。
 */
async function askHowToGroup(
  work: WorkEntry,
  parent: string,
  neighbours: number,
  allWorks: readonly WorkEntry[]
): Promise<SyncTarget | undefined> {
  const parentName = path.basename(parent);
  const total = neighbours + 1;

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(repo) 「${parentName}」をまとめて1つの置き場にする`,
        description: `${total}作品`,
        detail:
          "隣に並んでいる作品も同じ置き場に入ります。" +
          "別の環境へ移るとき、1回の取り寄せで全部そろいます。",
        choice: "together" as const,
      },
      {
        label: `$(book) 「${work.title}」だけを置き場にする`,
        description: "1作品",
        detail:
          "この作品だけを別のリポジトリにします。" +
          "すでに作品ごとに分けて管理している場合や、この作品だけを人に渡す場合はこちらです。",
        choice: "alone" as const,
      },
      cancelItem(),
    ],
    {
      title: "GitHubでどうまとめますか",
      placeHolder: `「${parentName}」の中に${total}作品あります`,
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("choice" in picked)) return undefined;

  return picked.choice === "together"
    ? buildSyncTarget(parent, allWorks)
    : buildSyncTarget(work.folderPath, allWorks);
}

/**
 * すでに置き場が決まっているとき、その中身を数え直す。
 *
 * 同期のたびに呼ぶ。**作品が増えていることがある**ので、覚えた数は使わない。
 */
export async function syncTargetFor(
  work: WorkEntry,
  allWorks: readonly WorkEntry[],
  run: GitCommandRunner = runGit
): Promise<SyncTarget> {
  const status = await readSyncStatus(work.folderPath, run);
  const root = "root" in status && status.root ? status.root : work.folderPath;
  return buildSyncTarget(root, allWorks);
}

/** 置き場に入っている作品の数（画面の言い回しを決めるのに使う） */
export function worksInTarget(
  target: SyncTarget,
  allWorks: readonly WorkEntry[]
): WorkEntry[] {
  return worksInside(allWorks, target.folderPath);
}
