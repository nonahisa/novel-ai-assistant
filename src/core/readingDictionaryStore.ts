import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { hashText } from "./hash";
import { isNotFound } from "./fileRead";
import { workPaths } from "./workRegistry";
import {
  parseReadingDictionary,
  readingDictionaryFileName,
  type ReadingDictionaryFile,
} from "./readingDictionary";

/**
 * 読みの辞書の置き場（`.aiwriter/readings/<話>.json`。設計書6.42.1）。
 *
 * ## 同期する
 *
 * `.aiwriter/readings/` は Git の除外（`IGNORED_PATHS`）に入れない。
 * **作者が直した読みは、作者が書いたデータである**——ノートPCで直した
 * 「じっぷん」が、デスクトップの読み上げでも効いてほしい。
 *
 * ## 書き込みは①（上書き）＋ハッシュ照合
 *
 * 台帳1つぶんの小さなファイルなので、回復先への退避は持たない
 * （スキル `implement` の実装ルール2、経路①）。代わりに、**読んだときの
 * 中身と書く直前の中身を突き合わせ**、違えば書かずに止める
 * （同期で別の機械の直しが入っていたら、それを押し流さない）。
 */

const READINGS_DIRECTORY = "readings";

/** 読んだ辞書と、照合に使う読んだ時点のハッシュ（無ければ undefined） */
export interface LoadedReadingDictionary {
  file: ReadingDictionaryFile;
  hash: string | undefined;
}

/** 書く直前に中身が変わっていた */
export class ReadingDictionaryChangedError extends Error {
  constructor() {
    super(
      "読みの辞書が、読み込んだあとに別の所で書き換えられました。開き直してからもう一度お試しください。"
    );
  }
}

/** その話の、作品フォルダーからの相対パス（`/` 区切り） */
export function episodeRelativePath(work: WorkEntry, episodePath: string): string {
  return path.relative(work.folderPath, episodePath).replace(/\\/g, "/");
}

export function readingDictionaryPath(work: WorkEntry, episodePath: string): string {
  return path.join(
    workPaths(work).aiwriter,
    READINGS_DIRECTORY,
    readingDictionaryFileName(episodeRelativePath(work, episodePath))
  );
}

/**
 * 辞書を読む。**無ければ空の辞書。壊れていたら投げる**（直さない。
 * CLAUDE.md 実装ルール2——作者の直しが入っている台帳を空で上書きしない）。
 */
export async function loadReadingDictionary(
  work: WorkEntry,
  episodePath: string
): Promise<LoadedReadingDictionary> {
  const file = readingDictionaryPath(work, episodePath);
  const text = await readTextOrUndefined(file);
  if (text === undefined) {
    return {
      file: {
        version: 1,
        episode: episodeRelativePath(work, episodePath),
        entries: [],
      },
      hash: undefined,
    };
  }
  try {
    return { file: parseReadingDictionary(text), hash: hashText(text) };
  } catch (error) {
    throw new Error(
      `読みの辞書（${path.basename(file)}）が読めません。ファイルを直すか消してから、もう一度お試しください。` +
        `（${error instanceof Error ? error.message : String(error)}）`
    );
  }
}

/**
 * 辞書を書く。`expectedHash` は読んだときのハッシュ（無かったなら undefined）。
 * **書く直前の中身が読んだときと違えば、書かずに投げる。**
 */
export async function saveReadingDictionary(
  work: WorkEntry,
  episodePath: string,
  file: ReadingDictionaryFile,
  expectedHash: string | undefined
): Promise<string> {
  const target = readingDictionaryPath(work, episodePath);
  const now = await readTextOrUndefined(target);
  const nowHash = now === undefined ? undefined : hashText(now);
  if (nowHash !== expectedHash) throw new ReadingDictionaryChangedError();

  const text = `${JSON.stringify(file, null, 2)}\n`;
  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
  await atomicWriteFile(target, new TextEncoder().encode(text));
  return hashText(text);
}

async function readTextOrUndefined(file: string): Promise<string | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(file));
  } catch (error) {
    // **「無い」だけを空として扱う。** 読めない（権限・同期中）を「無い」と
    // 取り違えると、書く側の照合も素通りして作者の直しを空で上書きする
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return new TextDecoder("utf-8").decode(bytes);
}
