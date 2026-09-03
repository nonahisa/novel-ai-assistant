import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  applyRenumberPlan,
  planRemoval,
} from "../core/episodeRenumber";
import { followEpisodeLedgers } from "./episodeLedgers";
import {
  describeSkippedDetail,
  findConflictedEpisodes,
  offerIndependentRenameCommit,
  reportRenumberOutcome,
} from "./episodeRenumberShared";
import { hasUnsavedChanges } from "../core/textFile";

/**
 * この話を削除し、後ろの話数を詰める（設計書6.67.4）。
 *
 * **`../core/git.js` を静的importする `episodeRenumberShared.ts` を使う。**
 * そのため `extension.ts` からは必ず動的import（`await import(...)`）で
 * 呼ぶこと（`insertEpisode.ts` と同じ約束、設計書5.8.5）。
 */

export interface RemoveEpisodeResult {
  /** 作品一覧を更新する必要があるか */
  changed: boolean;
}

export async function removeEpisodeAndRenumber(
  work: WorkEntry,
  episode: EpisodeFile,
  episodes: readonly EpisodeFile[]
): Promise<RemoveEpisodeResult> {
  let plan;
  try {
    plan = planRemoval(episodes, episode.filePath);
  } catch (error) {
    void vscode.window.showWarningMessage(
      error instanceof Error ? error.message : String(error)
    );
    return { changed: false };
  }

  // 削除する話自身の競合も、付け替え範囲の話の競合も、両方とも断る対象
  // （消す本人はまだ解決していない食い違いを抱えたまま消えることになる）
  const conflicted = [
    ...(episode.hasConflictMarkers ? [episode] : []),
    ...findConflictedEpisodes(episodes, plan.renames),
  ];
  if (conflicted.length > 0) {
    void vscode.window.showErrorMessage(
      `競合マーカーの残る話（${conflicted
        .map((e) => e.fileName)
        .join("、")}）が付け替えの範囲に含まれるため、削除を取りやめました。` +
        "先に競合を解決してください。"
    );
    return { changed: false };
  }
  if (plan.collisions.length > 0) {
    void vscode.window.showErrorMessage(
      "付け替え先の名前がぶつかるため、削除を取りやめました：" +
        plan.collisions.map((c) => c.toFileName).join("、")
    );
    return { changed: false };
  }

  const dirtyNote = hasUnsavedChanges(episode.filePath)
    ? "未保存の変更も破棄されます。"
    : "";
  const skippedDetail = describeSkippedDetail(plan);
  const detail =
    `ごみ箱に移動します。元に戻すことができます。${dirtyNote}` +
    (skippedDetail ? `\n${skippedDetail}` : "");

  const answer = await vscode.window.showWarningMessage(
    `「${episode.fileName}」を削除し、第${plan.pivot}話以降の${plan.renames.length}件の話数を詰めます。`,
    { modal: true, detail },
    "削除する"
  );
  if (answer !== "削除する") return { changed: false };

  // **消してから詰める。** 消す前に付け替えを始めると、繰り上がってきた
  // ファイルが「これから消す話」の名前と衝突する（`006.txt`→`005.txt` の
  // 移動先に、まだ消していない旧 `005.txt` が居座っている）
  try {
    await vscode.workspace.fs.delete(path.toUri(episode.filePath), {
      useTrash: true,
    });
  } catch (error) {
    void vscode.window.showErrorMessage(
      `削除できませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { changed: false };
  }

  const outcome = await applyRenumberPlan(plan, async (from, to) => {
    await vscode.workspace.fs.rename(path.toUri(from), path.toUri(to), {
      overwrite: false,
    });
  });

  const summary = await followEpisodeLedgers(
    work,
    outcome.done,
    { pivot: plan.pivot, delta: -1, removed: plan.pivot },
    episode.filePath
  );

  reportRenumberOutcome("削除", plan.pivot, outcome, summary);

  // **削除そのものはコミットに含めない。** 名前だけの独立コミットは
  // 「話数の調整」だけを表すもの（設計書6.67.1）。削除は内容の変更なので、
  // 作者がいつもの「記録」で別に取り込む
  await offerIndependentRenameCommit(
    work,
    outcome.done,
    `第${plan.pivot}話を削除したため、第${plan.pivot}話以降の話数を調整`
  );

  return { changed: true };
}
