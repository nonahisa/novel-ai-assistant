import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  applyRenumberPlan,
  planRemoval,
} from "../core/episodeRenumber";
import { followEpisodeLedgers, type RemovedEpisode } from "./episodeLedgers";
import {
  describeRenumberTargets,
  findConflictedEpisodes,
  findUnsavedEpisodes,
  offerIndependentRenameCommit,
  reportRenumberOutcome,
} from "./episodeRenumberShared";

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

  /*
    **未保存のまま開かれている話があれば、始めない**（設計書6.67.2）。
    消す話も対象に含める——未保存の編集を抱えたままごみ箱へ送ると、
    そのあとエディタが保存して**消したはずの話が戻る**ことがある。
  */
  const unsaved = findUnsavedEpisodes([
    episode.filePath,
    ...plan.renames.map((rename) => rename.fromPath),
  ]);
  if (unsaved.length > 0) {
    void vscode.window.showErrorMessage(
      `未保存の変更がある話（${unsaved.join("、")}）が削除・付け替えの対象です。` +
        "保存してからやり直してください。"
    );
    return { changed: false };
  }

  const detail =
    "ごみ箱に移動します。元に戻すことができます。\n" +
    describeRenumberTargets(work, plan);

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

  const summary = await followEpisodeLedgers(work, outcome.done, {
    filePath: episode.filePath,
    number: plan.pivot,
    next: nextEpisodeAfter(episodes, plan, outcome),
  });

  reportRenumberOutcome({
    action: "削除",
    pivot: plan.pivot,
    outcome,
    summary,
    emptyDetail:
      plan.skipped.length > 0
        ? "動かせる話が無かったため付け替えなし"
        : "後ろに話が無いため付け替えなし",
  });

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

/**
 * 消した話の**次の話**（付け替えが済んだあとの姿）。後ろに話が無ければ undefined。
 *
 * 開始の話を消された章の移し先に使う（設計書6.67.3）。**付け替え後の姿で
 * 返す**——章の台帳はパスで話を指すので、動く前の場所を渡すと存在しない
 * ファイルを指す。付け替えが止まって動かなかった話は、元の場所のままである。
 */
function nextEpisodeAfter(
  episodes: readonly EpisodeFile[],
  plan: { pivot: number; folder: string },
  outcome: { done: readonly { fromPath: string; toPath: string; newNumber: number }[] }
): RemovedEpisode["next"] {
  const folder = path.normalizeForComparison(plan.folder);
  const candidates = episodes
    .filter(
      (candidate) =>
        candidate.chapterStart !== null &&
        candidate.chapterStart > plan.pivot &&
        path.normalizeForComparison(path.dirname(candidate.filePath)) === folder
    )
    .sort((left, right) => (left.chapterStart ?? 0) - (right.chapterStart ?? 0));
  const next = candidates[0];
  if (!next) return undefined;

  const moved = outcome.done.find(
    (rename) =>
      path.normalizeForComparison(rename.fromPath) ===
      path.normalizeForComparison(next.filePath)
  );
  return moved
    ? { filePath: moved.toPath, number: moved.newNumber }
    : { filePath: next.filePath, number: next.chapterStart };
}
