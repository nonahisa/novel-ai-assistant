import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { WorkEntry } from "../models/types";
import { readTextFile, writeTextFilePreservingFormat } from "../core/textFile";
import {
  episodePlotFileName,
  renumberEpisodePlotHeading,
} from "../core/resumeSheet";
import {
  applyEpisodePlotRenames,
  planEpisodePlotShift,
  retiredEpisodePlotNameCandidates,
  type EpisodeChapterSpan,
  type EpisodePlotRename,
  type EpisodePlotShiftPlan,
} from "../core/episodePlotOrder";
import { pathExists } from "../core/fileSystem";
import { logFailure, useLogFile } from "../core/logger";
import { openInDefaultEditor } from "../views/openDocument";
import { episodePlotsDirOf, listEpisodePlotChapters } from "./episodePlotNav";

/**
 * 単話プロットのファイルの名前と見出しを付け替える口（設計書6.36・6.4.8）。
 *
 * 2つの道が使う。
 *
 * - プロットモードの「予定の話の並べ替え・差し込み」（`plotModePanel.ts`）
 * - 本文の話の差し込み・削除（`insertEpisode.ts`／`removeEpisode.ts`。
 *   作者の裁定、2026-09-23「単話プロットの話数も一緒にずらす」）
 *
 * **ファイル操作の経路は1本にする。** 名前の変更は `WorkspaceEdit`（上書き
 * しない）、見出しの書き換えは `writeTextFilePreservingFormat`（退避 →
 * 新規作成・ハッシュ照合・文字コードと改行の保持）。道ごとに写すと、
 * 片方だけ「上書きしない」を落とす。
 *
 * **`core/git.ts` を読み込まない。** プロットモードの画面は起動時に
 * 読み込まれるので、ここから Node 専用の口へ届くとブラウザ版が起動した
 * 瞬間に落ちる（設計書5.8.5）。
 */

/**
 * 置き場の中で名前を変える。**上書きしない**（既にあれば失敗させる）。
 *
 * `WorkspaceEdit` の名前変更を通すのは、開いているタブも新しい名前へ
 * ついて行かせるため（`workspace.fs.rename` だと、開いていたタブが
 * 「削除済み」のまま残る）。
 */
export async function renameEpisodePlotFile(
  directory: string,
  fromName: string,
  toName: string
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(
    paths.toUri(paths.join(directory, fromName)),
    paths.toUri(paths.join(directory, toName)),
    { overwrite: false }
  );
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error(`${fromName} の名前を ${toName} に変えられませんでした`);
  }
}

/**
 * 見出しの「第N話」を新しい話数に合わせる（題は保つ）。直せなかった
 * ファイル名を返す。
 *
 * 作者が見出しを書き換えていれば、そのまま（推測で作り直さない。
 * `renumberEpisodePlotHeading` が同じ文字列を返す）。
 */
export async function renumberEpisodePlotHeadings(
  work: WorkEntry,
  directory: string,
  renames: readonly EpisodePlotRename[]
): Promise<string[]> {
  const failures: string[] = [];
  for (const entry of renames) {
    const filePath = paths.join(directory, episodePlotFileName(entry.to));
    try {
      const content = await readTextFile(filePath);
      const next = renumberEpisodePlotHeading(content.text, entry.to);
      if (next === content.text) continue;
      const result = await writeTextFilePreservingFormat(
        filePath,
        next,
        content,
        content.hash
      );
      if (!result.ok) failures.push(paths.basename(filePath));
    } catch (error) {
      useLogFile(work.folderPath);
      logFailure("単話プロットの見出しの付け替えに失敗", {
        置き場: filePath,
        内容: messageOf(error),
      });
      failures.push(paths.basename(filePath));
    }
  }
  return failures;
}

/** 付け替えの前に見る、単話プロットの見込み */
export interface EpisodePlotShiftPreview {
  directory: string;
  plan: EpisodePlotShiftPlan;
  /** 名前が変わる・退けるファイルの場所（未保存で開いていないかを確かめる） */
  touchedPaths: string[];
}

/**
 * 本文の付け替えが**最後まで済んだとしたら**、単話プロットをどう動かすか。
 *
 * 確認の文（「単話プロット N 件も話数をずらします」）と、未保存の確認に使う。
 * 実際に動かすときは、本文の付け替えの結果で**もう一度**計画し直す
 * （`followEpisodePlots`）——途中で止まれば、動かす範囲が変わるため。
 */
export async function previewEpisodePlotShift(
  work: WorkEntry,
  input: {
    episodes: readonly EpisodeChapterSpan[];
    moved: ReadonlyMap<number, number>;
    delta: 1 | -1;
    pivot: number;
  }
): Promise<EpisodePlotShiftPreview> {
  const directory = await episodePlotsDirOf(work);
  const plan = planEpisodePlotShift({
    ...input,
    plotChapters: await listEpisodePlotChapters(directory),
    completed: true,
  });
  const chapters = [
    ...plan.renames.map((entry) => entry.from),
    ...(plan.retire === undefined ? [] : [plan.retire]),
  ];
  return {
    directory,
    plan,
    touchedPaths: chapters.map((chapter) =>
      paths.join(directory, episodePlotFileName(chapter))
    ),
  };
}

/**
 * 確認の文へ添える1〜2行。動かすものが無ければ空。
 *
 * **ぶつかるなら、始める前に言う**（本文の付け替えは止めない——単話
 * プロットは本文に従うもので、プロットの都合で本文を止める理由は無い）。
 */
export function describeEpisodePlotShiftPreview(
  preview: EpisodePlotShiftPreview
): string {
  const { plan } = preview;
  const lines: string[] = [];
  if (plan.renames.length > 0) {
    lines.push(
      plan.collisions.length > 0
        ? `単話プロットは話数をずらせません（${collisionText(plan.collisions)}）。そのまま残します。`
        : `単話プロット ${plan.renames.length} 件も話数をずらします（見出しの話数も直します）。`
    );
  }
  if (plan.retire !== undefined) {
    lines.push(
      `第${plan.retire}話の単話プロットは消さず、「削除した話」として名前を変えて残します。`
    );
  }
  return lines.join("\n");
}

/** 単話プロットの追従の結果 */
export interface EpisodePlotFollowResult {
  /** 話数をずらした単話プロットの数 */
  shifted: number;
  /** 削除した話の単話プロットを退けた先（置き場の中の名前と場所） */
  retired?: { chapter: number; fileName: string; filePath: string };
  /** 「単話プロット：理由」の形。本文の付け替えは失敗しても戻さない */
  failures: string[];
}

/**
 * 本文の付け替えの**結果**に、単話プロットを付いて行かせる（作者の裁定、
 * 2026-09-23）。
 *
 * 1. 削除した話の単話プロットを「削除した話_第N話_日時.md」へ退ける
 *    （**消さない**。退けられなければ、後ろを詰めるとその名前へ乗り上げる
 *    ので、話数はずらさない）
 * 2. ぶつかる付け替えがあれば、1件も動かさずに理由を返す
 * 3. 名前を付け替える（`applyEpisodePlotRenames`。一時名を通し、途中で
 *    失敗したら戻す）
 * 4. 見出しの話数を合わせる
 *
 * どこで止まっても**どこまで進んだか**を `failures` に書く（黙って半端に
 * しない）。本文のほうは既に動いているので、ここの失敗で本文を戻さない。
 */
export async function followEpisodePlots(
  work: WorkEntry,
  input: {
    episodes: readonly EpisodeChapterSpan[];
    moved: ReadonlyMap<number, number>;
    delta: 1 | -1;
    pivot: number;
    completed: boolean;
  },
  now: Date = new Date()
): Promise<EpisodePlotFollowResult> {
  const result: EpisodePlotFollowResult = { shifted: 0, failures: [] };
  let directory: string;
  let plotChapters: number[];
  try {
    directory = await episodePlotsDirOf(work);
    plotChapters = await listEpisodePlotChapters(directory);
  } catch (error) {
    result.failures.push(`単話プロット：置き場を読めませんでした（${messageOf(error)}）`);
    return result;
  }
  if (plotChapters.length === 0) return result;

  const plan = planEpisodePlotShift({ ...input, plotChapters });

  if (plan.retire !== undefined) {
    const retired = await retireEpisodePlot(directory, plan.retire, now);
    if (!retired.ok) {
      result.failures.push(
        `単話プロット：第${plan.retire}話の単話プロットを「削除した話」へ退けられませんでした（${retired.detail}）。` +
          "後ろの単話プロットの話数もずらしていません"
      );
      logFollowFailure(work, "削除した話の単話プロットを退けられない", retired.detail);
      return result;
    }
    result.retired = {
      chapter: plan.retire,
      fileName: retired.fileName,
      filePath: paths.join(directory, retired.fileName),
    };
  }

  if (plan.renames.length === 0) return result;
  if (plan.collisions.length > 0) {
    result.failures.push(
      `単話プロット：話数をずらすと名前がぶつかるため、1件も動かしていません（${collisionText(plan.collisions)}）`
    );
    return result;
  }

  const outcome = await applyEpisodePlotRenames(plan.renames, {
    rename: (fromName, toName) => renameEpisodePlotFile(directory, fromName, toName),
  });
  if (!outcome.ok) {
    logFollowFailure(
      work,
      "単話プロットの話数の付け替えに失敗",
      `${outcome.failedStep}：${outcome.detail}`
    );
    result.failures.push(
      outcome.rolledBack
        ? `単話プロット：話数をずらせませんでした（${outcome.failedStep}：${outcome.detail}）。元の名前に戻してあります`
        : `単話プロット：話数のずらしが途中で止まり、元に戻せなかったファイルがあります（${outcome.stranded
            .map((entry) => `${entry.now} は元の ${entry.original}`)
            .join("、")}）。置き場の中で名前を戻してください`
    );
    return result;
  }

  result.shifted = outcome.renames.length;
  const headingFailures = await renumberEpisodePlotHeadings(
    work,
    directory,
    outcome.renames
  );
  if (headingFailures.length > 0) {
    result.failures.push(
      `単話プロット：見出しの話数を直せなかったものがあります（${headingFailures.join("、")}）。見出しを手で直してください`
    );
  }
  return result;
}

/**
 * 削除した話の単話プロットを退ける。**上書きしない**——時刻の付いた
 * 名前を順に試し、既にある名前は飛ばす。
 */
async function retireEpisodePlot(
  directory: string,
  chapter: number,
  now: Date
): Promise<{ ok: true; fileName: string } | { ok: false; detail: string }> {
  let lastError = "使える名前が見つかりませんでした";
  for (const candidate of retiredEpisodePlotNameCandidates(chapter, now)) {
    if (await pathExists(paths.join(directory, candidate))) continue;
    try {
      await renameEpisodePlotFile(directory, episodePlotFileName(chapter), candidate);
      return { ok: true, fileName: candidate };
    } catch (error) {
      lastError = messageOf(error);
    }
  }
  return { ok: false, detail: lastError };
}

/**
 * 「削除した話」として残したことを知らせ、どうするかを訊く。
 *
 * **消す選択肢は出さない。** 消すのは作者が手で行う（作者の裁定、
 * 2026-09-23）。知らせは待たない——待つと、そのあとの「名前だけの
 * コミット」の確認が、この知らせを閉じるまで出てこない。
 */
export function offerRetiredEpisodePlot(
  retired: NonNullable<EpisodePlotFollowResult["retired"]>
): void {
  const keep = "残す";
  const open = "開いて確かめる";
  void vscode.window
    .showInformationMessage(
      `削除した第${retired.chapter}話の単話プロットは、「${retired.fileName}」として残しました` +
        "（予定の話の一覧には出ません。要らなければ、確かめてから手で消してください）。",
      keep,
      open
    )
    .then(async (picked) => {
      if (picked === open) await openInDefaultEditor(retired.filePath);
    });
}

function collisionText(collisions: readonly EpisodePlotRename[]): string {
  return collisions
    .map((entry) => `第${entry.from}話 → 第${entry.to}話`)
    .join("、");
}

function logFollowFailure(work: WorkEntry, context: string, detail: string): void {
  useLogFile(work.folderPath);
  logFailure(context, { 作品: work.title, 内容: detail });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
