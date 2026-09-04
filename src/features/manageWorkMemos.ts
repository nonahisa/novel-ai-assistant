import * as vscode from "vscode";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  createWorkMemo,
  deleteWorkMemo,
  transferMemoToWork,
  WorkMemoError,
  type WorkMemo,
} from "../core/workMemos";
import { episodePathFor } from "../core/bookStore";
import { ChapterStore } from "../core/chapterStore";
import { PostingStore } from "../core/postingStore";
import { SynopsisStore } from "../core/synopsisStore";
import type { WorkRegistry } from "../core/workRegistry";
import { askText, cancelItem } from "../views/dialogs";
import { openInDefaultEditor } from "../views/openDocument";
import { logFailure } from "../core/logger";

/**
 * 作品ごとのメモの操作（設計書6.71）。
 *
 * **専用の管理画面は作らない。** メモは作品一覧で見えているものなので、
 * 見えている場所（右クリック）で足せて消せるのがいちばん短い
 * （章立て `manageChapters.ts` と同じ考え方）。
 *
 * どの操作も**メモのファイルしか触らない**。原稿にも台帳にも書き込まない。
 *
 * 戻り値は「一覧を作り直す必要があるか」。呼ぶ側（`extension.ts`）が、
 * 変わったときだけ作品一覧を作り直すために使う。
 */

/** メモを1つ足す。題名を訊いて、空の `.md` を作って開く */
export async function addWorkMemo(work: WorkEntry): Promise<boolean> {
  const title = await askText({
    title: "メモを追加",
    prompt: `作品「${work.title}」にメモを足します。題名を入力してください。`,
    placeHolder: "書き出しの案",
    validateInput: (value) =>
      value.trim() ? undefined : "メモの題名を入力してください。",
  });
  if (!title?.trim()) return false;

  let memo: WorkMemo;
  try {
    memo = await createWorkMemo(work, title);
  } catch (error) {
    await report("メモの追加", work, error);
    return false;
  }

  // **作ったら開く。** 題名を入れた流れのまま書き始められる
  await openInDefaultEditor(memo.filePath);
  return true;
}

/**
 * メモをごみ箱へ入れる。
 *
 * 確認を1回だけ出す。ごみ箱からは戻せるので、二重に確かめるほどではない
 * （話ファイルの削除と同じ扱い）。
 */
export async function removeWorkMemo(
  work: WorkEntry,
  memo: WorkMemo
): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `メモ「${memo.title}」を削除しますか？`,
    {
      modal: true,
      detail:
        "ごみ箱に移動します。元に戻すことができます。" +
        "本文とほかのメモには触れません。",
    },
    "削除する"
  );
  if (answer !== "削除する") return false;

  try {
    await deleteWorkMemo(work, memo);
  } catch (error) {
    await report("メモの削除", work, error);
    return false;
  }

  void vscode.window.showInformationMessage(
    `メモ「${memo.title}」を削除しました。`
  );
  return true;
}

/**
 * 創作メモ集のメモを、別の作品へ移す（設計書6.71）。
 *
 * **移すのはファイルの場所だけで、中身は読みも書きもしない。**
 * メモ集で育てたメモが、作品の `設定/メモ/` へ移るだけである。
 *
 * 戻り値は、作り直すべき作品のID（移した元と先の両方）。
 */
export async function transferMemo(
  from: WorkEntry,
  episode: EpisodeFile,
  registry: WorkRegistry
): Promise<{ fromWorkId: string; toWorkId: string } | undefined> {
  const others = registry.list().filter((work) => work.id !== from.id);
  if (others.length === 0) {
    void vscode.window.showInformationMessage(
      "移す先の作品がありません。先に作品を登録してください。"
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    [
      ...others.map((work) => ({
        label: work.title,
        description: work.folderPath,
        work,
      })),
      // Escでも閉じられるが、それを知らない人には出口が無いように見える
      cancelItem(),
    ],
    { title: `「${episode.fileName}」をどの作品へ移しますか？` }
  );
  const to = picked && "work" in picked ? picked.work : undefined;
  if (!to) return undefined;

  // **移す前に、置いていく記録を数える。** 移してから知らせると、
  // 作者は「もう戻せないのか」と受け取る（実際は戻せる）
  const notes = await orphanNotes(from, episode);
  const answer = await vscode.window.showWarningMessage(
    `「${episode.fileName}」を作品「${to.title}」のメモへ移しますか？`,
    {
      modal: true,
      detail: [
        `${from.title} の本文から外し、${to.title} の 設定/メモ/ へ移します。` +
          "中身は書き換えません。",
        ...notes,
      ].join("\n"),
    },
    "移す"
  );
  if (answer !== "移す") return undefined;

  try {
    const result = await transferMemoToWork(from, episode.filePath, to);
    void vscode.window.showInformationMessage(
      [
        `「${result.memo.title}」を作品「${to.title}」のメモへ移しました。`,
        result.renamed
          ? `同じ題名のメモがあったので「${result.memo.fileName}」にしました。`
          : null,
        ...notes,
      ]
        .filter((line): line is string => line !== null)
        .join("　")
    );
    return { fromWorkId: from.id, toWorkId: to.id };
  } catch (error) {
    await report("メモの移管", from, error);
    return undefined;
  }
}

/**
 * 移したあとに、元の作品の台帳へ残る記録。
 *
 * **台帳は書き換えない。報せるだけにする**（設計書6.71）。
 *
 * 話数の詰め直し（6.68.4の4）では投稿記録を落としているが、あれは
 * **詰めた結果、別の話が同じパスへ来る**ためだった。移管では空いた場所へ
 * 誰も入らないので、記録が別の話を指すことはない。しかも移管は
 * 戻せる操作で、戻せば記録はまた正しくなる。**黙って消すほうが失う。**
 *
 * 読めない台帳は数えない（報せるためだけの読み取りで、移管を止めない）。
 */
async function orphanNotes(
  work: WorkEntry,
  episode: EpisodeFile
): Promise<string[]> {
  const episodePath = episodePathFor(work.folderPath, episode.filePath);
  const notes: string[] = [];

  try {
    const ledger = await new PostingStore(work).load();
    const posts = ledger.posts.filter(
      (post) => post.episodePath === episodePath
    );
    if (posts.length > 0) {
      notes.push(
        `投稿の記録が${posts.length}件、${work.title} の台帳に残ります（消しません）。`
      );
    }
  } catch {
    // 読めない台帳は「記録が無い」と同じ扱い。移管は止めない
  }

  try {
    const set = await new ChapterStore(work).load();
    const chapter = set.chapters.find(
      (entry) => entry.startEpisodePath === episodePath
    );
    if (chapter) {
      notes.push(
        `章「${chapter.name}」の開始の話でした。移すと開始が見つからなくなります。`
      );
    }
  } catch {
    // 同上
  }

  try {
    const set = await new SynopsisStore(work).load();
    if (set.episodes.some((entry) => entry.fileName === episode.fileName)) {
      notes.push(`各話あらすじの記録が ${work.title} に残ります（消しません）。`);
    }
  } catch {
    // 同上
  }

  return notes;
}

/** 失敗はログに残してから知らせる（原因にたどり着けるようにする） */
async function report(
  what: string,
  work: WorkEntry,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logFailure(what, {
    作品: work.title,
    種類: error instanceof WorkMemoError ? error.kind : "unknown",
    内容: message,
  });
  await vscode.window.showErrorMessage(message);
}
