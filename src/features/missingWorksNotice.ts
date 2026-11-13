import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { describeMissingWorks, unregisterMissingWorkLabel } from "../core/syncAllPlan";
import { readRepoRoot, runGit, type GitCommandRunner } from "../core/git";
import { buildSyncTarget } from "../core/syncTarget";
import { findMissingWorks } from "../core/workFolderPresence";
import { normalizeForComparison } from "../core/paths";
import { logFailure } from "../core/logger";
import { whenNoticePicked } from "../views/notify";

// ログの書き先：呼び出し側が先に向けている（`gitSync.ts` は押した作品、`recordChanges` は置き場の在る作品）

/**
 * その作品が入っている置き場（git の最上位）で、フォルダーが見つからない登録済みの作品
 * （2026-11-14。設計書5.5.14）。
 *
 * 作品1つから始まる操作（作品1つの同期・分岐合流・復元）が、同じ判断を使うために1つだけ置く。
 * 置き場の根は git に訊く。**読めなければ作品のフォルダーを根とみなす**（それでも
 * その中の作品は調べられる。読めないことを理由に止めない）。
 */
export async function findMissingWorksAt(
  folderPath: string,
  works: readonly WorkEntry[],
  run: GitCommandRunner = runGit
): Promise<WorkEntry[]> {
  const root = (await readRepoRoot(folderPath, run)) ?? folderPath;
  return findMissingWorks(buildSyncTarget(root, works).works);
}

/**
 * 作品1つの同期で、同じ置き場にフォルダーが見つからない作品があって記録を止めたときの知らせ
 * （2026-11-14 の作者の実データ。「すべて同期」の `work_missing` と同じ文。設計書5.5.14）。
 *
 * 作者が押した操作（取り込みの前の記録・作品ごとの一覧の「記録」・分岐合流・復元・
 * GitHub のセットアップ）から呼ぶ。知らせを何か所にも写すと片方だけ直して食い違うため。
 *
 * ボタンは既存の「作品の登録を解除」（`novelai.removeWork`。確認の窓が出る）へ渡す。
 * **ボタンの答えは待たない**（取り込みの旗の中からも呼ばれる。`whenNoticePicked`）
 *
 * @param pressed 知らせの失敗を残す作品のフォルダー（フォルダーが在る作品。無ければ保管庫へ）
 */
export function noticeMissingWorks(
  pressed: string | undefined,
  gone: readonly WorkEntry[]
): void {
  if (gone.length === 0) return;
  logFailure("作品のフォルダーが見つからないので、記録を止めた", {
    見つからない作品: gone.map((one) => one.folderPath).join("、"),
  });
  showMissingWorksNotice(pressed, gone);
}

/**
 * 見つからない作品の組（登録の道を並べたもの）のうち、この起動で知らせを出したもの。
 *
 * 自動の道（開いたときの点検・自動の送り直し）は、起動のたび・送り直しのたびに同じ置き場で
 * 止まる。そのたびに知らせを出すと積もって読まれなくなるので、**同じ組は1回の起動で1回まで**
 * にする（点検と送り直しで共有する。点検で知らせた組を、送り直しがもう一度出さない）。
 * 作品を戻した・登録を外したあとで、また別の作品が見えなくなれば組が変わるので、また出る。
 */
const noticedOnce = new Set<string>();

/**
 * 自動の道で止めたときの知らせ。**同じ組は1回の起動で1回まで**（`noticedOnce`）。
 * ログは呼び出し側が毎回1行残す（何度止めたかはログで読めるようにする）。
 *
 * @returns 知らせを出したか（この起動ですでに出していれば false）
 */
export function noticeMissingWorksOnce(
  pressed: string | undefined,
  gone: readonly WorkEntry[]
): boolean {
  if (gone.length === 0) return false;
  // 区切りは改行（道に入らない文字）。並びの違いで別の組と数えないよう並べ替える
  const key = gone
    .map((one) => normalizeForComparison(one.folderPath))
    .sort()
    .join("\n");
  if (noticedOnce.has(key)) return false;
  noticedOnce.add(key);
  showMissingWorksNotice(pressed, gone);
  return true;
}

/** 試験用：この起動で出した知らせを忘れる（試験ごとに「起動したて」へ戻す） */
export function forgetMissingWorksNotices(): void {
  noticedOnce.clear();
}

function showMissingWorksNotice(
  pressed: string | undefined,
  gone: readonly WorkEntry[]
): void {
  const unregister = unregisterMissingWorkLabel(gone[0]);
  whenNoticePicked(
    vscode.window.showWarningMessage(describeMissingWorks(gone, "after"), unregister),
    async (action) => {
      if (action !== unregister) return;
      await vscode.commands.executeCommand("novelai.removeWork", {
        type: "work",
        work: gone[0],
      });
    },
    { label: "作品のフォルダーが無いときの案内", ...(pressed ? { workFolder: pressed } : {}) }
  );
}
