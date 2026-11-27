import type { WorkEntry } from "../models/types";
import { workLog } from "../core/logger";

/**
 * 作品の本文が変わったと見張りが知らせたときに、2つのパネルの指摘を追いつかせる
 * （作者の知らせ 2026-11-27「誤字脱字を直接書き換えるとパネルから消えない」。
 * 設計書6.96.5）。
 *
 * 1. 提案パネルが、まだ手を付けていない指摘を本文で照らし直す
 *    （`ProposalPanel.noteManuscriptEdited`）
 * 2. 開いている校正・メモパネルが置き場から読み直す。読み直しは同じ探し直し
 *    （`locateFindings`）で、本文から消えた原文の指摘を落とす
 *
 * **2つを同じ知らせで動かす**ので、片方で外れたものはもう片方からも外れる。
 * 校正・メモパネルは VS Code の保存でも読み直すが、原稿エディターの書き込みや
 * 外のエディターでの書き換えは、ここからしか届かない。
 *
 * `extension.ts` の閉包に直に書かないのは、単体テストで配線を確かめるため
 * （画面の自動テストは作者が PC にいるあいだ流せない）。
 */
export interface ManuscriptEditFollowDeps {
  /** `changedFiles` は見張りが受けた道（無ければ作品ぜんたい）。照らす範囲を狭めるだけ */
  noteManuscriptEdited: (work: WorkEntry, changedFiles?: readonly string[]) => Promise<void>;
  refreshFindings: (workId: string) => Promise<void>;
}

export async function followManuscriptEdit(
  work: WorkEntry,
  deps: ManuscriptEditFollowDeps,
  changedFiles?: readonly string[]
): Promise<void> {
  // **片方が落ちても、もう片方は動かす。** どちらも読むだけで本文には触らない
  try {
    await deps.noteManuscriptEdited(work, changedFiles);
  } catch (error) {
    workLog(work.folderPath).line(
      `提案パネル：本文の変化に合わせた照らし直しに失敗しました（${messageOf(error)}）。`
    );
  }
  try {
    await deps.refreshFindings(work.id);
  } catch (error) {
    workLog(work.folderPath).line(
      `校正・メモパネル：本文の変化に合わせた読み直しに失敗しました（${messageOf(error)}）。`
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
