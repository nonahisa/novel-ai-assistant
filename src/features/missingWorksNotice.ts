import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { describeMissingWorks, unregisterMissingWorkLabel } from "../core/syncAllPlan";
import { logFailure } from "../core/logger";
import { whenNoticePicked } from "../views/notify";

// ログの書き先：呼び出し側が先に向けている（`gitSync.ts` は押した作品、`recordChanges` は置き場の在る作品）

/**
 * 作品1つの同期で、同じ置き場にフォルダーが見つからない作品があって記録を止めたときの知らせ
 * （2026-11-14 の作者の実データ。「すべて同期」の `work_missing` と同じ文。設計書5.5.14）。
 *
 * 取り込みの前の記録（`gitSync.ts`）と、作品ごとの一覧の「記録」（`gitOnboarding.ts` の
 * `recordChanges`）の両方から呼ぶ。知らせを2か所に写すと片方だけ直して食い違うため。
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
