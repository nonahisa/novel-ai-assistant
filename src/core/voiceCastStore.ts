import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { hashText } from "./hash";
import { isNotFound } from "./fileRead";
import { workPaths } from "./workRegistry";
import { readingDictionaryFileName } from "./readingDictionary";
import { episodeRelativePath } from "./readingDictionaryStore";
import {
  emptyVoiceAssignment,
  parseCastFile,
  parseVoiceAssignment,
  type CastFile,
  type VoiceAssignmentFile,
} from "./voiceCast";

/**
 * 人物の声で朗読する——推定の結果と声の割り当ての置き場（設計書6.42.3）。
 *
 * - 台詞の話者と感情：`.aiwriter/voiceCast/<話>.json`（話ごと）
 * - 声の割り当て：`.aiwriter/voices.json`（作品ごと）
 *
 * ## どちらも同期する
 *
 * 作者が直した話者・感情、選んだ声は作者のデータである（読みの辞書と同じ。
 * 6.42.1）。声は**話者の uuid とスタイルの名前**で持つので、別のPCに同じ
 * 話者が入っていれば、そこでも同じ声で読める。
 *
 * ## 書き込みは①（上書き）＋ハッシュ照合
 *
 * 読みの辞書と同じ形。**書く直前の中身が読んだときと違えば、書かずに止める**
 * （同期で入った別の機械の直しを押し流さない）。壊れたファイルは直さずに止める。
 */

const CAST_DIRECTORY = "voiceCast";
const ASSIGNMENT_FILE = "voices.json";

export class VoiceCastChangedError extends Error {
  constructor(what: string) {
    super(
      `${what}が、読み込んだあとに別の所で書き換えられました。開き直してからもう一度お試しください。`
    );
  }
}

export interface Loaded<T> {
  file: T;
  /** 読んだときのハッシュ（ファイルが無ければ undefined） */
  hash: string | undefined;
}

export function voiceCastPath(work: WorkEntry, episodePath: string): string {
  return path.join(
    workPaths(work).aiwriter,
    CAST_DIRECTORY,
    readingDictionaryFileName(episodeRelativePath(work, episodePath))
  );
}

export function voiceAssignmentPath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, ASSIGNMENT_FILE);
}

/** 推定の結果を読む。無ければ空、壊れていたら投げる */
export async function loadVoiceCast(
  work: WorkEntry,
  episodePath: string
): Promise<Loaded<CastFile>> {
  const file = voiceCastPath(work, episodePath);
  const text = await readTextOrUndefined(file);
  if (text === undefined) {
    return {
      file: { version: 1, episode: episodeRelativePath(work, episodePath), entries: [] },
      hash: undefined,
    };
  }
  try {
    return { file: parseCastFile(text), hash: hashText(text) };
  } catch (error) {
    throw new Error(
      `台詞の話者と感情のファイル（${path.basename(file)}）が読めません。ファイルを直すか消してから、もう一度お試しください。` +
        `（${error instanceof Error ? error.message : String(error)}）`
    );
  }
}

export async function saveVoiceCast(
  work: WorkEntry,
  episodePath: string,
  file: CastFile,
  expectedHash: string | undefined
): Promise<string> {
  return writeGuarded(voiceCastPath(work, episodePath), file, expectedHash, "台詞の話者と感情");
}

/** 声の割り当てを読む。無ければ空、壊れていたら投げる */
export async function loadVoiceAssignment(
  work: WorkEntry
): Promise<Loaded<VoiceAssignmentFile>> {
  const file = voiceAssignmentPath(work);
  const text = await readTextOrUndefined(file);
  if (text === undefined) return { file: emptyVoiceAssignment(), hash: undefined };
  try {
    return { file: parseVoiceAssignment(text), hash: hashText(text) };
  } catch (error) {
    throw new Error(
      `声の割り当てのファイル（${ASSIGNMENT_FILE}）が読めません。ファイルを直すか消してから、もう一度お試しください。` +
        `（${error instanceof Error ? error.message : String(error)}）`
    );
  }
}

export async function saveVoiceAssignment(
  work: WorkEntry,
  file: VoiceAssignmentFile,
  expectedHash: string | undefined
): Promise<string> {
  return writeGuarded(voiceAssignmentPath(work), file, expectedHash, "声の割り当て");
}

async function writeGuarded(
  target: string,
  value: unknown,
  expectedHash: string | undefined,
  what: string
): Promise<string> {
  const now = await readTextOrUndefined(target);
  const nowHash = now === undefined ? undefined : hashText(now);
  if (nowHash !== expectedHash) throw new VoiceCastChangedError(what);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
  await atomicWriteFile(target, new TextEncoder().encode(text));
  return hashText(text);
}

async function readTextOrUndefined(file: string): Promise<string | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(file));
  } catch (error) {
    // 「無い」だけを空として扱う（読めないのを無いと取り違えると、照合を素通りする）
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return new TextDecoder("utf-8").decode(bytes);
}
