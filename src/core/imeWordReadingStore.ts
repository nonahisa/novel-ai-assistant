import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { hashText } from "./hash";
import { isNotFound } from "./fileRead";
import { workPaths } from "./workRegistry";
import {
  parseImeWordDismissalFile,
  parseImeWordReadingFile,
  type ImeWordDismissalFile,
  type ImeWordReadingFile,
} from "./imeWordReading";

/**
 * IMEで打った語の読みの提案の、控えと見送りの印の置き場（設計書6.42.2。
 * 作者の裁定、2026-10-25）。
 *
 * ## 2つに分けて置く
 *
 * - **控え** `.aiwriter/imeWordReadings.json`——**同期しない**（`IGNORED_PATHS`）。
 *   漢字を含む語を確定するたびに書くので、同期すると2台で食い違い、変更の記録が
 *   出続ける（名前の控え `imeReadings.json` と同じ理由）。回数・直前の字は
 *   その機械で打った事実で、別の機械へ届けなくてよい（作者の選択 Q2）
 * - **見送りの印** `.aiwriter/imeReadingDismissals.json`——**同期する**
 *   （作者の選択 Q2「GitHub で同期する」）。［見送る］は作者の判断なので、
 *   ノートPCで見送った提案がデスクトップで出直さないようにする。書くのは
 *   ［見送る］を押したときだけなので、食い違いは起きにくい
 *
 * 採った読みは読みの辞書（`.aiwriter/readings/`）へ入り、そちらで同期される。
 *
 * 見送りの印を読みの辞書のファイルへ欄として足さなかったのは、辞書を書く道
 * （AIの作り直し・一覧での直し）が知っている欄しか組み立てず、保存のたびに
 * 印が消えるため。
 *
 * ## 書き込みは①（上書き）＋ハッシュ照合
 *
 * `imeReadingStore.ts` と同じ。**書く直前に読み直し、読んだときと違えば書かずに
 * 止める**。壊れていたら直さずに投げる（CLAUDE.md 実装ルール2）。
 */

const WORDS_FILE = "imeWordReadings.json";
const DISMISSALS_FILE = "imeReadingDismissals.json";

/** 書く直前に中身が変わっていた */
export class ImeWordFileChangedError extends Error {
  constructor(label: string) {
    super(`${label}が、読み込んだあとに別の所で書き換えられました。`);
  }
}

interface JsonFile<T> {
  name: string;
  label: string;
  parse: (text: string) => T;
  empty: () => T;
}

const WORDS: JsonFile<ImeWordReadingFile> = {
  name: WORDS_FILE,
  label: "IMEの読みの提案の控え",
  parse: parseImeWordReadingFile,
  empty: () => ({ version: 1, entries: [] }),
};

const DISMISSALS: JsonFile<ImeWordDismissalFile> = {
  name: DISMISSALS_FILE,
  label: "IMEの読みの見送りの印",
  parse: parseImeWordDismissalFile,
  empty: () => ({ version: 1, entries: [] }),
};

export function imeWordReadingsPath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, WORDS_FILE);
}

export function imeReadingDismissalsPath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, DISMISSALS_FILE);
}

export interface Loaded<T> {
  file: T;
  /** 読んだ時点のハッシュ（ファイルが無ければ undefined） */
  hash: string | undefined;
}

async function load<T>(work: WorkEntry, kind: JsonFile<T>): Promise<Loaded<T>> {
  const target = path.join(workPaths(work).aiwriter, kind.name);
  const text = await readTextOrUndefined(target);
  if (text === undefined) return { file: kind.empty(), hash: undefined };
  try {
    return { file: kind.parse(text), hash: hashText(text) };
  } catch (error) {
    throw new Error(
      `${kind.label}（${kind.name}）が読めません。ファイルを直すか消してから、もう一度お試しください。` +
        `（${error instanceof Error ? error.message : String(error)}）`
    );
  }
}

async function save<T>(
  work: WorkEntry,
  kind: JsonFile<T>,
  file: T,
  expectedHash: string | undefined
): Promise<void> {
  const target = path.join(workPaths(work).aiwriter, kind.name);
  const now = await readTextOrUndefined(target);
  const nowHash = now === undefined ? undefined : hashText(now);
  if (nowHash !== expectedHash) throw new ImeWordFileChangedError(kind.label);
  const text = `${JSON.stringify(file, null, 2)}\n`;
  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
  await atomicWriteFile(target, new TextEncoder().encode(text));
}

/**
 * 読んで・変えて・書く。照合で弾かれたら1度だけ読み直してやり直す
 * （同じ作品を開いた別の窓・同期で入った分に足す）。2度目も弾かれたら投げる
 */
async function update<T, R>(
  work: WorkEntry,
  kind: JsonFile<T>,
  change: (file: T) => { file: T; result: R }
): Promise<R> {
  for (let attempt = 0; ; attempt++) {
    const loaded = await load(work, kind);
    const next = change(loaded.file);
    try {
      await save(work, kind, next.file, loaded.hash);
      return next.result;
    } catch (error) {
      if (!(error instanceof ImeWordFileChangedError) || attempt >= 1) throw error;
    }
  }
}

/** 控えを読む。**無ければ空。壊れていたら投げる** */
export function loadImeWordReadings(work: WorkEntry): Promise<Loaded<ImeWordReadingFile>> {
  return load(work, WORDS);
}

export function updateImeWordReadings<R>(
  work: WorkEntry,
  change: (file: ImeWordReadingFile) => { file: ImeWordReadingFile; result: R }
): Promise<R> {
  return update(work, WORDS, change);
}

/** 見送りの印を読む。**無ければ空。壊れていたら投げる** */
export function loadImeReadingDismissals(
  work: WorkEntry
): Promise<Loaded<ImeWordDismissalFile>> {
  return load(work, DISMISSALS);
}

export function updateImeReadingDismissals(
  work: WorkEntry,
  change: (file: ImeWordDismissalFile) => ImeWordDismissalFile
): Promise<void> {
  return update(work, DISMISSALS, (file) => ({ file: change(file), result: undefined }));
}

async function readTextOrUndefined(file: string): Promise<string | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(file));
  } catch (error) {
    // **「無い」だけを空として扱う。** 読めない（権限・同期中）を「無い」と
    // 取り違えると、書く側の照合も素通りして見送りの印を空で上書きする
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return new TextDecoder("utf-8").decode(bytes);
}
