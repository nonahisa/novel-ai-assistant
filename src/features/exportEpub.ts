import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  BOOK_DIR,
  BOOK_FILE,
  defaultBookConfig,
  parseBookConfig,
  type BookConfig,
} from "../models/book";
import { scanWork } from "../core/scanner";
import { readTextFile, type TextFileContent } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { atomicWriteFile } from "../core/atomicWrite";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import {
  episodeTitle,
  formatChapterLabel,
} from "../core/episodeLabel";
import { timestampedFileNameCandidates } from "../core/timestampedFileName";
import { notationModeFor } from "../core/manuscriptRender";
import { buildEpub, type EpubChapter, type EpubCover } from "../core/epubPackage";
import { randomUuid } from "../core/runtime";
import { revealFolder } from "../views/openDocument";
import { logFailure } from "../core/logger";

/**
 * 本文からEPUB3の電子書籍を組んで書き出す（設計書6.65.4の第1段）。
 *
 * **原稿は読むだけで、1文字も書き換えない。** 空行の詰めもページの
 * 割りも書き出し時の変換であって、原稿ファイルには触れない。
 *
 * ## 本の設計図が無くても1回は出せる
 *
 * `設定/書籍/book.json` を読むが、**無ければ作品名から既定値で組む**。
 * 第1段には設計図を作る画面が無い（第2段で作る）ので、ここで止めると
 * 誰も本を出せない。**壊れていたときだけは止める**——勝手に直して
 * 上書きすると、作者が書いた値が黙って消える（他の台帳と同じ約束）。
 *
 * ## 書き出し先は `.aiwriter/exports/`
 *
 * PDF出力と同じ慣習。組み直せるものなので `.gitignore` で除外済み
 * （`core/workRegistry.ts` の `IGNORED_PATHS`）。**既存ファイルへは
 * 書かない**——名前がぶつかったら秒・連番で別名にする。
 */
export async function exportEpub(work: WorkEntry): Promise<void> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    void vscode.window.showInformationMessage(
      `「${work.title}」に本文のファイルが見つかりません。`
    );
    return;
  }

  let config: BookConfig;
  try {
    config = await readBookConfig(work);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("本の設計図の読み込み", { 作品: work.title, 内容: message });
    await vscode.window.showErrorMessage(
      `設定/${BOOK_DIR}/${BOOK_FILE} を読めませんでした。${message}` +
        "　直してからもう一度お試しください（こちらでは書き換えません）。"
    );
    return;
  }

  const format = await readWorkFormat(work);

  const chapters: EpubChapter[] = [];
  /** 競合マーカーが残っている話。組んでも読めない本になるので外す */
  const conflicted: string[] = [];
  for (const episode of scan.episodes) {
    let file: TextFileContent;
    try {
      file = await readTextFile(episode.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("EPUBの組み立て", {
        ファイル: episode.fileName,
        内容: message,
      });
      await vscode.window.showErrorMessage(
        `${episode.fileName} を読めませんでした。${message}`
      );
      return;
    }
    // **未解決の競合をそのまま組まない。** マーカーと両方の版が混ざった本は
    // 読めないうえ、配ってから気づくことになる（PDF出力と同じ）
    if (file.hasConflictMarkers) {
      conflicted.push(episode.fileName);
      continue;
    }
    chapters.push({
      heading: headingFor(episode, format),
      // 投稿サイトからDLしたファイルは、先頭にヘッダーが付いている。
      // 本文だけを組む（作品一覧の文字数計測と同じ切り分け）
      body: parseEpisodeMetadata(file.text).body,
      // **話ごとに記法を見る。** 1つの作品に `.md` と `.txt` が混ざる
      notation: notationModeFor(episode.fileName),
    });
  }

  if (chapters.length === 0) {
    void vscode.window.showWarningMessage(
      "選んだ本文はすべて未解決の競合を含んでいるため、書き出しませんでした。" +
        "「競合解決」で直してからもう一度お試しください。"
    );
    return;
  }

  let cover: EpubCover | null;
  try {
    cover = await readCover(work, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("表紙画像の読み込み", { 作品: work.title, 内容: message });
    await vscode.window.showErrorMessage(
      `表紙の画像を読めませんでした。${message}` +
        `　設定/${BOOK_DIR}/${BOOK_FILE} の coverImagePath を確かめてください。`
    );
    return;
  }

  let epub: Uint8Array;
  try {
    epub = buildEpub({
      config,
      chapters,
      cover,
      // 本を見分ける唯一の札。書き出すたびに新しい本として扱われる
      identifier: `urn:uuid:${randomUuid()}`,
      modified: isoSeconds(new Date()),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("EPUBの組み立て", { 作品: work.title, 内容: message });
    await vscode.window.showErrorMessage(`本を組めませんでした。${message}`);
    return;
  }

  let target: string;
  try {
    target = await writeExport(work, epub);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("EPUBの書き出し", { 作品: work.title, 内容: message });
    await vscode.window.showErrorMessage(
      `EPUBを保存できませんでした。${message}`
    );
    return;
  }

  const droppedNote =
    conflicted.length > 0
      ? `\n未解決の競合を含む${conflicted.length}件は外しました（${conflicted.join(
          "、"
        )}）。`
      : "";
  const coverNote = cover ? "" : "\n表紙は題名だけの扉にしました。";

  const action = await vscode.window.showInformationMessage(
    `EPUBを書き出しました（${chapters.length}話）。\n${target}` +
      coverNote +
      droppedNote,
    "フォルダーを開く"
  );
  if (action === "フォルダーを開く") await revealFolder(target);
}

/**
 * 本の設計図を読む。**無ければ作品名から既定値**、壊れていれば例外。
 */
async function readBookConfig(work: WorkEntry): Promise<BookConfig> {
  const workConfig = await readWorkConfig(work);
  const target = path.join(
    workPaths(work, workConfig).settings,
    BOOK_DIR,
    BOOK_FILE
  );

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(target));
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    ) {
      return defaultBookConfig(work.title);
    }
    throw error;
  }

  return parseBookConfig(
    JSON.parse(new TextDecoder().decode(bytes)),
    work.title
  );
}

/**
 * 表紙画像を読む。指定が無ければ null（文字だけの扉になる）。
 *
 * **指定があるのに読めなければ止める。** 黙って扉に差し替えると、
 * 表紙を用意したつもりの本が表紙なしで出来上がる。
 */
async function readCover(
  work: WorkEntry,
  config: BookConfig
): Promise<EpubCover | null> {
  if (!config.coverImagePath) return null;

  const target = path.join(work.folderPath, config.coverImagePath);
  const data = await vscode.workspace.fs.readFile(path.toUri(target));
  return { fileName: config.coverImagePath, data };
}

/**
 * 本に出す見出し。
 *
 * PDF出力と同じ作り方にする（`episodeLabel.ts`）。話数と題が二重に
 * 並ばないよう、`episodeTitle` を通すのを忘れないこと。
 */
function headingFor(
  episode: EpisodeFile,
  format: WorkFormatKey | undefined
): string {
  const chapter = formatChapterLabel(episode, format);
  const title = episodeTitle(episode, chapter);
  return [chapter, title].filter(Boolean).join("　") || episode.fileName;
}

/** 書き出し先。**新規作成だけ**を使い、名前がぶつかったら別名にする */
async function writeExport(work: WorkEntry, epub: Uint8Array): Promise<string> {
  const config = await readWorkConfig(work);
  const directory = path.join(workPaths(work, config).aiwriter, EXPORT_DIR);
  await vscode.workspace.fs.createDirectory(path.toUri(directory));

  const target = await freshExportPath(directory, new Date());
  await atomicWriteFile(target, epub, { mode: "create" });
  return target;
}

/** 組み直せるものの置き場所。`.gitignore` で除外済み（PDF出力と同じ） */
const EXPORT_DIR = "exports";

/** まだ使われていない保存先を決める。名前の作り方は `timestampedFileName.ts` */
async function freshExportPath(directory: string, at: Date): Promise<string> {
  for (const name of timestampedFileNameCandidates("電子書籍", at, ".epub")) {
    const target = path.join(directory, name);
    try {
      await vscode.workspace.fs.stat(path.toUri(target));
    } catch {
      // 読めない＝まだ無い。ここへ書く
      return target;
    }
  }
  throw new Error("書き出し先の名前を決められませんでした。");
}

/**
 * `dcterms:modified` の形（`2026-09-03T01:23:45Z`）。
 *
 * **ミリ秒は付けない。** EPUB3の仕様が秒までと決めており、
 * `toISOString()` そのままだと検証器（epubcheck）が警告を出す。
 */
function isoSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}
