import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import { atomicWriteFile, AtomicWriteFileError } from "./atomicWrite";
import { sanitizeFileName } from "./episodeParser";
import { TIMESTAMPED_NAME_TRIES } from "./timestampedFileName";
import { episodePathFor } from "./bookStore";

/**
 * 作品ごとのメモと、創作メモ集からの移管（設計書6.71）。
 *
 * **1メモ＝1ファイル（`設定/メモ/題名.md`）。** この形だから
 *
 *   - Gitで同期でき、消しても「復元」から戻せる
 *   - **移管が「ファイルの移動」で済む**——中身に触れないので、Gitは
 *     改名として追える（6.67.1と同じ理屈）
 *
 * が同時に成り立つ。1つのJSONに全メモを詰めると、どちらも失われる。
 *
 * **メモは原稿ではない。** `設定/` の下にあるので `scanner.ts` の走査
 * （`collectTextFiles` が `設定` を飛ばす）に入らず、話数・文字数・
 * あらすじ・投稿・校正のどれも掛からない。メモは書き散らす場所であり、
 * 指摘されると書けなくなる。
 *
 * VS Code の `workspace.fs` しか使わない（`node:fs` は使わない）ので、
 * ブラウザ版でもそのまま動く。
 */

/** メモの置き場。`設定/` の下に作る */
export const MEMO_DIR_NAME = "メモ";

/**
 * メモの拡張子。
 *
 * **設定（`newEpisodeExtension`）より `.md` を優先する。** 創作メモ集の
 * メモと同じ判断（6.70）で、メモは見出しや箇条書きで書き散らすものだから。
 */
export const MEMO_EXTENSION = ".md";

export interface WorkMemo {
  /** 題名。**ファイル名そのもの**（拡張子を除いたもの）である */
  title: string;
  fileName: string;
  filePath: string;
}

/** 移管の結果。呼び出し側が作者へ報せるのに要るものだけを返す */
export interface MemoTransfer {
  /** 移した先のメモ */
  memo: WorkMemo;
  /** 同じ題名があったので、連番の別名にしたか */
  renamed: boolean;
  /** 移す前の場所（元の作品フォルダからの相対パス、区切りは `/`） */
  fromPath: string;
}

export type WorkMemoErrorKind =
  | "invalid_title"
  | "duplicate"
  | "outside_work"
  | "same_work";

export class WorkMemoError extends Error {
  constructor(
    message: string,
    readonly kind: WorkMemoErrorKind,
    /** 作者に見せる場所。通知から開けるようにするために持つ */
    readonly filePath?: string
  ) {
    super(message);
    this.name = "WorkMemoError";
  }
}

/** その作品のメモの置き場。作品設定で `設定/` の名前を変えていれば従う */
export async function memoDirectoryOf(work: WorkEntry): Promise<string> {
  const config = await readWorkConfig(work);
  return path.join(workPaths(work, config).settings, MEMO_DIR_NAME);
}

/**
 * その作品のメモを、題名の順に並べて返す。
 *
 * **置き場が無い作品は空**（＝一覧に枝を出さない）。メモを使わない作者の
 * 画面に、空の枝を並べないためである。
 */
export async function listWorkMemos(work: WorkEntry): Promise<WorkMemo[]> {
  const directory = await memoDirectoryOf(work);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(directory));
  } catch {
    // まだ1つも作っていない作品では置き場そのものが無い。
    // 「読めなかった」と「メモが無い」を分けても、出せるものは同じ
    return [];
  }

  return entries
    .filter(([name, type]) => type === vscode.FileType.File && isMemoFile(name))
    .map(([name]) => memoAt(directory, name))
    .sort((left, right) => left.title.localeCompare(right.title, "ja"));
}

/**
 * 題名を決めて、空のメモを作る。
 *
 * **中身は空のまま置く。** 題名だけ決まっていれば、あとは作者が書く。
 * こちらで見出しや日付を入れると、書き出しの邪魔になる。
 */
export async function createWorkMemo(
  work: WorkEntry,
  title: string
): Promise<WorkMemo> {
  const fileName = memoFileName(title);
  const directory = await memoDirectoryOf(work);
  await vscode.workspace.fs.createDirectory(path.toUri(directory));

  const memo = memoAt(directory, fileName);
  if (await exists(memo.filePath)) {
    throw duplicateError(memo);
  }

  try {
    // **必ず `mode: "create"`。** 既存のメモを上書きする道は作らない
    await atomicWriteFile(memo.filePath, new Uint8Array(), { mode: "create" });
  } catch (error) {
    // 確かめてから書くまでの隙に作られていた（同期で降ってきた等）
    if (
      error instanceof AtomicWriteFileError &&
      error.kind === "path_conflict"
    ) {
      throw duplicateError(memo);
    }
    throw error;
  }
  return memo;
}

/**
 * メモをごみ箱へ入れる。
 *
 * **消す前に、その作品の中のファイルかを確かめる。** 一覧の行から
 * 渡ってくる場所をそのまま消すと、作り物のノードで作品の外を指せてしまう。
 */
export async function deleteWorkMemo(
  work: WorkEntry,
  memo: WorkMemo
): Promise<void> {
  // **置き場の中だけを消す。** 作品の中というだけでは、原稿や設定資料まで
  // 消せてしまう（この関数はメモの削除しか請け負わない）
  assertInside(
    await memoDirectoryOf(work),
    memo.filePath,
    `消せるのは、作品「${work.title}」のメモだけです`
  );
  await vscode.workspace.fs.delete(path.toUri(memo.filePath), {
    useTrash: true,
  });
}

/**
 * メモを別の作品へ移す（設計書6.71）。
 *
 * **読んで書き直すのではなく、`rename` で move する。** 中身に触れないので
 * Gitが改名として追え、履歴が切れない（6.67.1と同じ理屈）。
 *
 * **移す先に同じ題名があれば連番の別名にする**（`旅の途中-2.md`）。
 * 既存のメモを上書きする道は作らない——そのときは改名として追えなくなるが、
 * 作者が書いたものを消すよりはよい。
 *
 * @param from 移す元の作品（創作メモ集）
 * @param sourcePath 移すファイル（メモ集の「話」ファイル）
 * @param to 移す先の作品
 */
export async function transferMemoToWork(
  from: WorkEntry,
  sourcePath: string,
  to: WorkEntry
): Promise<MemoTransfer> {
  if (from.id === to.id) {
    throw new WorkMemoError(
      "同じ作品へは移せません。移す先の作品を選び直してください。",
      "same_work",
      sourcePath
    );
  }
  assertInside(
    from.folderPath,
    sourcePath,
    `移せるのは、作品「${from.title}」の中のファイルだけです`
  );

  const fromPath = episodePathFor(from.folderPath, sourcePath);
  const directory = await memoDirectoryOf(to);
  await vscode.workspace.fs.createDirectory(path.toUri(directory));

  // **拡張子は `.md` へ揃える。** 一覧は `.md` しか拾わないので、
  // `.txt` のまま移すと、移した先で見えないメモになる（中身は触らない）
  const candidates = memoNameCandidates(
    path.basename(sourcePath, path.extname(sourcePath))
  );
  for (const fileName of candidates) {
    const memo = memoAt(directory, fileName);
    if (await exists(memo.filePath)) continue;
    try {
      await vscode.workspace.fs.rename(
        path.toUri(sourcePath),
        path.toUri(memo.filePath),
        // 上書きは決してしない（既にあれば次の候補へ）
        { overwrite: false }
      );
    } catch (error) {
      if (isFileExists(error)) continue;
      throw error;
    }
    return { memo, renamed: fileName !== candidates[0], fromPath };
  }

  throw new WorkMemoError(
    `「${path.basename(sourcePath)}」と同じ題名のメモが多すぎて、置き場所を決められませんでした。` +
      "移す先のメモの題名を整理してから、もう一度お試しください。",
    "duplicate",
    sourcePath
  );
}

/** 題名からファイル名を作る。使えない記号は全角へ落とす（話と同じ規則） */
export function memoFileName(title: string): string {
  const cleaned = sanitizeFileName(title).trim();
  if (!cleaned) {
    throw new WorkMemoError(
      "メモの題名を入力してください。",
      "invalid_title"
    );
  }
  return `${cleaned}${MEMO_EXTENSION}`;
}

/**
 * 同じ題名を避けるための名前の候補。
 *
 * **既存ファイルは上書きできない**（`atomicWrite.ts` の設計）ので、
 * 別名を順に試す。試す回数は時刻で名前を決めるファイル
 * （`timestampedFileName.ts`）と同じ考え方で、そこの上限を借りている。
 */
function memoNameCandidates(title: string): string[] {
  const base = sanitizeFileName(title).trim() || "無題";
  const names = [`${base}${MEMO_EXTENSION}`];
  for (let n = 2; names.length < Math.max(TIMESTAMPED_NAME_TRIES, 1); n += 1) {
    names.push(`${base}-${n}${MEMO_EXTENSION}`);
  }
  return names;
}

function memoAt(directory: string, fileName: string): WorkMemo {
  return {
    title: path.basename(fileName, MEMO_EXTENSION),
    fileName,
    filePath: path.join(directory, fileName),
  };
}

/** 一覧に出すメモか。隠しファイルと一時ファイルは拾わない */
function isMemoFile(fileName: string): boolean {
  if (fileName.startsWith(".")) return false;
  return path.extname(fileName).toLowerCase() === MEMO_EXTENSION;
}

/**
 * その場所の中を指しているか。
 *
 * 外を指す場所を渡されたら、読みも書きもせずに断る
 * （`workRegistry.ts` の `resolveInsideWork` と同じ判定）。**一覧の行から
 * 渡ってくる場所を、そのまま消したり動かしたりしない。**
 */
function assertInside(base: string, filePath: string, what: string): void {
  const root = path.resolve(base);
  const relative = path.relative(root, path.resolve(filePath));
  if (!relative || path.goesOutside(root, relative)) {
    throw new WorkMemoError(
      `${what}。「${filePath}」は「${base}」の外にあります。`,
      "outside_work",
      filePath
    );
  }
}

function duplicateError(memo: WorkMemo): WorkMemoError {
  return new WorkMemoError(
    `「${memo.title}」というメモは既にあります。別の題名にしてください。`,
    "duplicate",
    memo.filePath
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(path.toUri(filePath));
    return true;
  } catch {
    return false;
  }
}

function isFileExists(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError && error.code === "FileExists"
  );
}
