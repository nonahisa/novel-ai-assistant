import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { hashText } from "./hash";
import { isNotFound } from "./fileRead";
import {
  ensureOnUseIgnoreRule,
  IME_READINGS_IGNORE_RULE,
  workPaths,
} from "./workRegistry";
import { parseImeReadingFile, type ImeReadingFile } from "./imeReading";

/**
 * IMEで打った読みの控えの置き場（`.aiwriter/imeReadings.json`。設計書6.42.2）。
 *
 * ## 同期しない
 *
 * 作者の裁定（2026-10-24 夜「同期から外す」）。除外の行は起動の一括
 * （`IGNORED_PATHS`）ではなく、**初めて控えを書く前にその作品の .gitignore へ
 * 足す**（`ON_USE_IGNORED_PATHS`。作者の裁定、2026-10-26。語の控えと揃えた）。
 * 名前を確定するたびに書くので、同期すると2台で食い違い
 * やすく、変更の記録が出続ける。**設定資料の読み（`reading`）に入った分は、
 * 設定資料と一緒にこれまでどおり同期される**——別の機械へ届けたい読みは
 * そちらで届く。0.111.4 では同期していた（読みの辞書と同じ扱いだった）。
 *
 * ## 書き込みは①（上書き）＋ハッシュ照合
 *
 * 作品に1つの小さなファイルなので、回復先への退避は持たない（スキル `implement`
 * の実装ルール2、経路①）。**書く直前に読み直し、読んだときのハッシュと違えば
 * 書かずに止める**。同期しなくても、同じ機械の別の窓（同じ作品を2つの窓で
 * 開いている）が書くことはあるので、照合は残す。
 */

const FILE_NAME = "imeReadings.json";

export interface LoadedImeReadings {
  file: ImeReadingFile;
  /** 読んだ時点のハッシュ（ファイルが無ければ undefined） */
  hash: string | undefined;
}

/** 書く直前に中身が変わっていた */
export class ImeReadingsChangedError extends Error {
  constructor() {
    super("IMEの読みの控えが、読み込んだあとに別の所で書き換えられました。");
  }
}

export function imeReadingsPath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, FILE_NAME);
}

/** 控えを読む。**無ければ空。壊れていたら投げる**（直さない。CLAUDE.md 実装ルール2） */
export async function loadImeReadings(work: WorkEntry): Promise<LoadedImeReadings> {
  const file = imeReadingsPath(work);
  const text = await readTextOrUndefined(file);
  if (text === undefined) return { file: { version: 1, entries: [] }, hash: undefined };
  try {
    return { file: parseImeReadingFile(text), hash: hashText(text) };
  } catch (error) {
    throw new Error(
      `IMEの読みの控え（${FILE_NAME}）が読めません。ファイルを直すか消してから、もう一度お試しください。` +
        `（${error instanceof Error ? error.message : String(error)}）`
    );
  }
}

/**
 * 控えを書く。`expectedHash` は読んだときのハッシュ（無かったなら undefined）。
 * **書く直前の中身が読んだときと違えば、書かずに投げる。**
 */
export async function saveImeReadings(
  work: WorkEntry,
  file: ImeReadingFile,
  expectedHash: string | undefined
): Promise<string> {
  const target = imeReadingsPath(work);
  const now = await readTextOrUndefined(target);
  const nowHash = now === undefined ? undefined : hashText(now);
  if (nowHash !== expectedHash) throw new ImeReadingsChangedError();
  if (now === undefined) {
    // **初めて書くときだけ、その作品の .gitignore へ足す**（作者の裁定、
    // 2026-10-26。語の控えと同じ形）。起動の一括で足すと、IMEで名前を打って
    // いない作品まで .gitignore が書き換わり、「記録待ち」が出る。
    // **控えより先に足す**——逆の順だと、間に同期が挟まると控えが Git に入る。
    // 足せなければ控えも書かずに投げる（同期に入る形で書くよりよい）
    await ensureOnUseIgnoreRule(workPaths(work).root, IME_READINGS_IGNORE_RULE);
  }

  const text = `${JSON.stringify(file, null, 2)}\n`;
  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
  await atomicWriteFile(target, new TextEncoder().encode(text));
  return hashText(text);
}

/**
 * 読んで・変えて・書く。**照合で弾かれたら1度だけ読み直してやり直す**
 * （別の窓の回数が入っていたら、それに足す）。2度目も弾かれたら投げる。
 *
 * @returns 書いたあとの控え
 */
export async function updateImeReadings(
  work: WorkEntry,
  change: (file: ImeReadingFile) => ImeReadingFile
): Promise<ImeReadingFile> {
  for (let attempt = 0; ; attempt++) {
    const loaded = await loadImeReadings(work);
    const next = change(loaded.file);
    try {
      await saveImeReadings(work, next, loaded.hash);
      return next;
    } catch (error) {
      if (!(error instanceof ImeReadingsChangedError) || attempt >= 1) throw error;
    }
  }
}

async function readTextOrUndefined(file: string): Promise<string | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(file));
  } catch (error) {
    // **「無い」だけを空として扱う。** 読めない（権限・クラウドの取り寄せ中）を
    // 「無い」と取り違えると、書く側の照合も素通りしてこれまでの回数を空で上書きする
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return new TextDecoder("utf-8").decode(bytes);
}
