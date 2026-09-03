import * as vscode from "vscode";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  findChapterStartingAt,
  withChapterStartingAt,
  withoutChapterStartingAt,
  type Chapter,
  type ChapterSet,
} from "../models/chapter";
import { ChapterStore, ChapterStoreError } from "../core/chapterStore";
import { episodePathFor } from "../core/bookStore";
import { askText } from "../views/dialogs";
import { logFailure } from "../core/logger";

/**
 * 章立ての手動の管理（設計書6.66.2）。
 *
 * **専用の管理画面は作らない。** 章は作品一覧で見えているものなので、
 * 見えている場所（右クリック）で直せるのがいちばん短い。
 *
 * どの操作も**台帳（`設定/章立て.json`）しか書き換えない**。原稿にも
 * ほかの台帳にも触らない——章を外しても話は1つも消えない。
 *
 * 戻り値は「台帳を書き換えたか」。呼ぶ側（`extension.ts`）が、
 * 書き換えたときだけ作品一覧を作り直すために使う。
 */

/**
 * この話から章を始める。
 *
 * **既にその話から始まる章があれば、改名として扱う**（6.66.2）。
 * 同じ話から始まる章を2つ作れてしまうと、どちらが本当か決められない。
 */
export async function startChapterAt(
  work: WorkEntry,
  episode: EpisodeFile
): Promise<boolean> {
  const store = new ChapterStore(work);
  const set = await load(store, work);
  if (!set) return false;

  const startPath = episodePathFor(work.folderPath, episode.filePath);
  const existing = findChapterStartingAt(set.chapters, startPath);

  const name = await askChapterName(
    existing
      ? `「${episode.fileName}」から始まる章の名前を変えます。`
      : `「${episode.fileName}」から新しい章が始まります。章の名前を入力してください。`,
    existing?.name
  );
  if (!name) return false;

  const saved = await save(
    store,
    work,
    { ...set, chapters: withChapterStartingAt(set.chapters, startPath, name) }
  );
  if (!saved) return false;

  void vscode.window.showInformationMessage(
    existing
      ? `章の名前を「${name}」に変えました。`
      : `「${episode.fileName}」から章「${name}」を始めました。`
  );
  return true;
}

/** 章の名前を変える（章ノードの右クリック） */
export async function renameChapter(
  work: WorkEntry,
  chapter: Chapter
): Promise<boolean> {
  const store = new ChapterStore(work);
  const set = await load(store, work);
  if (!set) return false;

  // **一覧に出ている章が、いまも台帳にあるとは限らない。** 別の端末で
  // 外されたものを名前だけ書き戻すと、消したはずの章がよみがえる
  const existing = findChapterStartingAt(set.chapters, chapter.startEpisodePath);
  if (!existing) {
    void vscode.window.showWarningMessage(
      `章「${chapter.name}」は台帳にありません。作品一覧を更新してください。`
    );
    return false;
  }

  const name = await askChapterName(
    `章「${existing.name}」の名前を変えます。`,
    existing.name
  );
  if (!name || name === existing.name) return false;

  const saved = await save(store, work, {
    ...set,
    chapters: withChapterStartingAt(
      set.chapters,
      existing.startEpisodePath,
      name
    ),
  });
  if (!saved) return false;

  void vscode.window.showInformationMessage(
    `章の名前を「${name}」に変えました。`
  );
  return true;
}

/**
 * 章を外す。**話は1つも消えない**（章なしに戻るだけ）。
 *
 * 確認を1回だけ出す。取り消せる操作（もう一度その話から章を始めれば
 * 元に戻る）なので、二重に確かめるほどではない。
 */
export async function removeChapter(
  work: WorkEntry,
  chapter: Chapter
): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `章「${chapter.name}」を外しますか？`,
    {
      modal: true,
      detail:
        "話は削除されません。この章に入っていた話は、章なしに戻ります。" +
        "章を付け直すときは、開始にしたい話の右クリックから「ここから章を始める」を選んでください。",
    },
    "章を外す"
  );
  if (answer !== "章を外す") return false;

  const store = new ChapterStore(work);
  const set = await load(store, work);
  if (!set) return false;

  if (!findChapterStartingAt(set.chapters, chapter.startEpisodePath)) {
    // 既に無いのなら目的は達している。作り直さずに、そのまま知らせる
    void vscode.window.showInformationMessage(
      `章「${chapter.name}」は既に外されています。`
    );
    return true;
  }

  const saved = await save(store, work, {
    ...set,
    chapters: withoutChapterStartingAt(set.chapters, chapter.startEpisodePath),
  });
  if (!saved) return false;

  void vscode.window.showInformationMessage(
    `章「${chapter.name}」を外しました。話はそのまま残っています。`
  );
  return true;
}

/**
 * 章の名前を尋ねる。
 *
 * 空のままでは決められないので、入力欄の側で止める（保存まで進んでから
 * 断ると、作者は何が悪かったのか分からない）。
 */
async function askChapterName(
  prompt: string,
  current?: string
): Promise<string | undefined> {
  const name = await askText({
    title: current ? "章の名前を変える" : "ここから章を始める",
    prompt,
    value: current,
    placeHolder: "第一章　出立",
    validateInput: (value) =>
      value.trim() ? undefined : "章の名前を入力してください。",
  });
  return name?.trim() || undefined;
}

async function load(
  store: ChapterStore,
  work: WorkEntry
): Promise<ChapterSet | undefined> {
  try {
    return await store.load();
  } catch (error) {
    await report("章立ての読み込み", work, error);
    return undefined;
  }
}

async function save(
  store: ChapterStore,
  work: WorkEntry,
  set: ChapterSet
): Promise<boolean> {
  try {
    await store.save(set);
    return true;
  } catch (error) {
    await report("章立ての保存", work, error);
    return false;
  }
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
    種類: error instanceof ChapterStoreError ? error.kind : "unknown",
    内容: message,
  });
  await vscode.window.showErrorMessage(message);
}
