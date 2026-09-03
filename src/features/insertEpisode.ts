import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { SUPPORTED_EXTENSIONS } from "../models/types";
import {
  applyRenumberPlan,
  episodeNumberOf,
  planInsertion,
} from "../core/episodeRenumber";
import { followEpisodeLedgers } from "./episodeLedgers";
import {
  describeSkippedDetail,
  findConflictedEpisodes,
  offerIndependentRenameCommit,
  reportRenumberOutcome,
} from "./episodeRenumberShared";
import { askText } from "../views/dialogs";
import { pathExists } from "../core/fileSystem";

/**
 * この話の前に1話ぶん割り込ませる（設計書6.67.4）。
 *
 * **`../core/git.js` を静的importする `episodeRenumberShared.ts` を使う。**
 * そのため `extension.ts` からは必ず動的import（`await import(...)`）で
 * 呼ぶこと——静的importするとNode専用の口（`node:child_process`）がブラウザ
 * 版の起動時に巻き込まれる（設計書5.8.5）。
 */

export interface InsertEpisodeResult {
  /** 作品一覧を更新する必要があるか */
  changed: boolean;
  /**
   * 新しく作った話のパス。呼び出し側が執筆量の基準を置き直し、
   * 原稿エディタで開くために使う（`addEpisode` と同じ流儀）。
   */
  newFilePath?: string;
}

export async function insertEpisodeBefore(
  work: WorkEntry,
  episode: EpisodeFile,
  episodes: readonly EpisodeFile[]
): Promise<InsertEpisodeResult> {
  const pivot = episodeNumberOf(episode.fileName);
  if (pivot === null) {
    void vscode.window.showWarningMessage(
      `「${episode.fileName}」は話数を持たないため、前に挿入できません。`
    );
    return { changed: false };
  }

  const plan = planInsertion(episodes, pivot);

  const conflicted = findConflictedEpisodes(episodes, plan.renames);
  if (conflicted.length > 0) {
    void vscode.window.showErrorMessage(
      `競合マーカーの残る話（${conflicted
        .map((e) => e.fileName)
        .join("、")}）が付け替えの範囲に含まれるため、挿入を取りやめました。` +
        "先に競合を解決してください。"
    );
    return { changed: false };
  }
  if (plan.collisions.length > 0) {
    void vscode.window.showErrorMessage(
      "付け替え先の名前がぶつかるため、挿入を取りやめました：" +
        plan.collisions.map((c) => c.toFileName).join("、")
    );
    return { changed: false };
  }

  const cfg = vscode.workspace.getConfiguration("novelai");
  const digits = cfg.get<number>("episodeNumberDigits", 3);
  const ext = cfg.get<string>("episodeFileExtension", ".txt");
  const defaultName = `${String(pivot).padStart(digits, "0")}${ext}`;

  // **サブタイトルはファイル名の入力欄で訊く**（`novelai.addEpisode` と同じ形。
  // 既定は番号だけで、作者が続けてサブタイトルを書き足せる）
  const fileName = await askText({
    title: "この話の前に挿入",
    prompt: "新しい話数ファイルの名前",
    value: defaultName,
    valueSelection: [0, defaultName.length - ext.length],
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "ファイル名を入力してください";
      if (/[/\\:*?"<>|]/.test(trimmed))
        return "ファイル名に使えない文字が含まれています";
      const extension = path.extname(trimmed).toLowerCase();
      if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(extension))
        return "拡張子は .txt か .md にしてください";
      return null;
    },
  });
  if (!fileName) return { changed: false };

  const answer = await vscode.window.showWarningMessage(
    `第${pivot}話以降の${plan.renames.length}件の話数を付け替えます。`,
    { modal: true, detail: describeSkippedDetail(plan) },
    "付け替える"
  );
  if (answer !== "付け替える") return { changed: false };

  const outcome = await applyRenumberPlan(plan, async (from, to) => {
    await vscode.workspace.fs.rename(path.toUri(from), path.toUri(to), {
      overwrite: false,
    });
  });

  const summary = await followEpisodeLedgers(work, outcome.done, {
    pivot,
    delta: 1,
  });

  reportRenumberOutcome("挿入", pivot, outcome, summary);

  if (outcome.stoppedAt) {
    // **途中で止まったら新しい話は作らない。** 目当ての番号の場所が
    // まだ空いているとは限らず（止まった箇所より手前は動いていない）、
    // 中途半端な状態に新規作成まで重ねると余計に分かりにくくなる
    return { changed: outcome.done.length > 0 };
  }

  const dir = path.dirname(episode.filePath);
  const newFilePath = path.join(dir, fileName.trim());
  if (await pathExists(newFilePath)) {
    // 起こらないはずだが（付け替えでこの番号は空いたはず）、上書きはしない
    void vscode.window.showErrorMessage(
      "同じ名前のファイルがすでにあるため、新しい話のファイルは作れませんでした。" +
        "話数の付け替え自体は完了しています。"
    );
  } else {
    await vscode.workspace.fs.writeFile(
      path.toUri(newFilePath),
      new TextEncoder().encode("")
    );
  }

  // **挿入した新しい話のファイルは、名前だけのコミットに入れない**（設計書6.67.1）。
  // `outcome.done` には付け替え（旧→新パス）しか入っておらず、新規作成した
  // ファイルは含まれないので、そのまま渡してよい
  await offerIndependentRenameCommit(
    work,
    outcome.done,
    `第${pivot}話を挿入したため、第${pivot}話以降の話数を調整`
  );

  return {
    changed: true,
    newFilePath: (await pathExists(newFilePath)) ? newFilePath : undefined,
  };
}
