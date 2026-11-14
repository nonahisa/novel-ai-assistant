import { sha256Bytes, sha256Text } from "./hash";
import { fromUri } from "./paths";
import { canRunProcesses, hostTag, randomUuid } from "./runtime";
import * as path from "./paths";
import * as vscode from "vscode";

export const RECOVERY_GENERATIONS_PER_FILE = 5;
/**
 * 回復先の名前。**写しを作らない**ため、ここから配る
 * （`bookStore` の未保存の控えも同じ場所へ置く）。
 */
export const RECOVERY_DIRECTORY_NAME = ".novelai-recovery";
let recoverySequence = 0;

export type AtomicWriteFileOptions =
  | { mode: "create" }
  | { mode: "replace"; expectedHash: string };

export type AtomicWritePersistenceState = "not_saved" | "ambiguous";

export class AtomicWriteFileError extends Error {
  constructor(
    message: string,
    readonly kind: "modified_externally" | "path_conflict",
    /** 新しい内容の配置結果。エラー種別から推測せず、失敗地点で確定する。 */
    readonly persistenceState: AtomicWritePersistenceState,
    readonly recoveryPaths: string[] = []
  ) {
    super(message);
    this.name = "AtomicWriteFileError";
  }
}

/**
 * 新規作成は同じディレクトリの一時ファイルから配置する。
 * 既存パスには公開FS APIで利用できる原子的CASがないため、ガード付き置換は
 * 正規パスへ書込・rename・deleteせず、提案内容を回復パスへ残して失敗を返す。
 */
/**
 * 書き込む直前に呼ばれる。設定ファイルの監視が「自分の書き込み」を
 * 見分けるために使う。
 *
 * 書き込み口を1つに絞れているので、ここに1か所だけ置けば済む。
 * 各ストアへ渡して回すと、渡し忘れたところが外部変更として誤検知される。
 */
let writeObserver: ((filePath: string) => void) | undefined;

export function setWriteObserver(
  observer: ((filePath: string) => void) | undefined
): void {
  writeObserver = observer;
}

export async function atomicWriteFile(
  filePath: string,
  bytes: Uint8Array,
  options?: AtomicWriteFileOptions
): Promise<void> {
  writeObserver?.(filePath);
  const destination = path.toUri(filePath);
  const nonce = `${hostTag()}-${randomUuid()}`;
  const temporary = path.toUri(`${filePath}.novelai-${nonce}.tmp`);
  const stagedHash = hashBytes(bytes);

  await vscode.workspace.fs.writeFile(temporary, bytes);

  if (!options) {
    try {
      if (await replaceInOneStep(fromUri(temporary), fromUri(destination))) return;
      await vscode.workspace.fs.rename(temporary, destination, { overwrite: true });
    } catch (error) {
      // 本体の上書きの移動は「保存先を消す → 名前を変える」の2手なので、2手目で投げると
      // 保存先はもう無い。そこで一時ファイルまで消すと、古い中身も新しい中身も失う。
      // 保存先が無い（または確かめられない）ときは一時ファイルを残し、場所を知らせる
      let destinationRemains = false;
      try {
        destinationRemains = (await readFileIfExists(destination)) !== undefined;
      } catch {
        destinationRemains = false;
      }
      if (!destinationRemains) {
        throw manualRecoveryError(
          `保存先「${fromUri(destination)}」を置き換えられませんでした（${errorMessage(error)}）。新しい内容は一時ファイルに残っています。`,
          [fromUri(destination), fromUri(temporary)],
          "not_saved"
        );
      }
      await deleteStagedFileBestEffort(temporary, stagedHash);
      throw error;
    }
    return;
  }

  if (options.mode === "create") {
    await placeNewFile(destination, temporary, stagedHash);
    return;
  }

  await replaceGuarded(
    destination,
    temporary,
    stagedHash,
    options.expectedHash
  );
}

/**
 * 一時ファイルを保存先へ**1回の名前の変更で**入れ替える（指定なしの道）。入れ替えたら true。
 *
 * **なぜ `vscode.workspace.fs.rename` に任せないのか**（2026-11-14、遅いノートPCの画面テスト）。
 * 本体の上書きの移動（`FileService.doMoveCopy`）は、**保存先を消してから**親フォルダーを確かめ、
 * 別の手で名前を変える（1.90 と 1.145 の束で確かめた）。その間は、同期・相談・MCP・投稿の記録の
 * 読み手から見て保存先が「無い」。Node の `rename` は Windows でも既存を置き換える1手
 * （MoveFileEx の置き換え）なので、この隙間ができない。
 *
 * **手元の OS のパスで、Node が居るときだけ**使う。ブラウザ版（実装ルール7）と URI の場所では
 * false を返し、呼び手が今までの道を通る。`node:fs/promises` は動的 import に限る。
 *
 * 読み手がちょうど開いている間は、Windows が置き換えを断る（EPERM・EACCES・EBUSY）。
 * そのときは短く間をおいて繰り返し、`ONE_STEP_RETRY_MS` を過ぎたら false で今までの道へ譲る
 * ——隙間はあっても、書き込みそのものを失敗にはしない（今までと同じ振る舞いに戻るだけ）。
 * それ以外の失敗はそのまま投げる。
 */
async function replaceInOneStep(temporaryPath: string, destinationPath: string): Promise<boolean> {
  if (oneStepOverride === false) return false;
  if (!canRunProcesses()) return false;
  if (path.isUriString(temporaryPath) || path.isUriString(destinationPath)) return false;
  let renameOnDisk: (from: string, to: string) => Promise<void>;
  try {
    ({ rename: renameOnDisk } = await import("node:fs/promises"));
  } catch {
    return false;
  }
  const deadline = Date.now() + ONE_STEP_RETRY_MS;
  let pause = 2;
  for (;;) {
    try {
      await renameOnDisk(temporaryPath, destinationPath);
      return true;
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
      if (Date.now() + pause > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pause));
      pause = Math.min(pause * 2, 25);
    }
  }
}

/** 置き換えを断られたときに繰り返す長さ。読み手の1回の読みは数ミリ秒で終わる */
const ONE_STEP_RETRY_MS = 500;

/**
 * 試験から1手の置き換えを止める（`false`）／製品の選び方へ戻す（`undefined`）。
 *
 * 単体テストの多くは `workspace.fs` を記憶の中の作り物にしているので、本物のディスクを
 * 触る Node の道を通すと一時ファイルが見えない。`test/unit/support/setup.ts` が全試験の前に
 * `false` を差し込み、`atomicWriteReplaceGap.test.ts` が `undefined` に戻して本物で確かめる。
 */
let oneStepOverride: false | undefined;

export function setOneStepReplaceForTests(value: false | undefined): void {
  oneStepOverride = value;
}

async function placeNewFile(
  destination: vscode.Uri,
  temporary: vscode.Uri,
  stagedHash: string
): Promise<void> {
  if (await readFileIfExists(destination)) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    throw new AtomicWriteFileError(
      `保存先「${fromUri(destination)}」は一時書き込み中に作成されました。`,
      "path_conflict",
      "not_saved",
      [fromUri(destination), fromUri(temporary)]
    );
  }

  try {
    await vscode.workspace.fs.rename(temporary, destination, {
      overwrite: false,
    });
  } catch (error) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    if (isFileExists(error) || await readFileIfExists(destination)) {
      throw new AtomicWriteFileError(
        `保存先「${fromUri(destination)}」が同時に作成されました。`,
        "path_conflict",
        "not_saved",
        [fromUri(destination), fromUri(temporary)]
      );
    }
    throw error;
  }

  const placed = await readFileIfExists(destination);
  if (!placed || hashBytes(placed) !== stagedHash) {
    throw manualRecoveryError(
      `配置直後に保存先「${fromUri(destination)}」が変更されました。`,
      [fromUri(destination)],
      "ambiguous"
    );
  }
}

async function replaceGuarded(
  destination: vscode.Uri,
  temporary: vscode.Uri,
  stagedHash: string,
  expectedHash: string
): Promise<void> {
  let proposal: vscode.Uri;
  try {
    proposal = path.toUri(await createManagedRecoveryPath(fromUri(destination)));
  } catch (error) {
    throw manualRecoveryError(
      `回復ディレクトリを準備できませんでした: ${errorMessage(error)}`,
      [fromUri(destination), recoveryDirectoryFor(fromUri(destination)), fromUri(temporary)],
      "not_saved"
    );
  }

  try {
    await vscode.workspace.fs.rename(temporary, proposal, { overwrite: false });
  } catch (error) {
    throw manualRecoveryError(
      `提案内容を回復パスへ移動できませんでした: ${errorMessage(error)}`,
      [fromUri(destination), fromUri(proposal), fromUri(temporary)],
      "not_saved"
    );
  }

  let retainedProposal: Uint8Array | undefined;
  try {
    retainedProposal = await readFileIfExists(proposal);
  } catch (error) {
    throw manualRecoveryError(
      `提案内容の回復ファイルを確認できませんでした: ${errorMessage(error)}`,
      [fromUri(destination), fromUri(proposal)],
      "not_saved"
    );
  }
  if (!retainedProposal || hashBytes(retainedProposal) !== stagedHash) {
    throw manualRecoveryError(
      `提案内容の回復ファイルが一時書き込み時の内容と一致しません。`,
      [fromUri(destination), fromUri(proposal)],
      "not_saved"
    );
  }

  let current: Uint8Array | undefined;
  try {
    current = await readFileIfExists(destination);
  } catch (error) {
    throw manualRecoveryError(
      `保存先を確認できませんでした: ${errorMessage(error)}`,
      [fromUri(destination), fromUri(proposal)],
      "not_saved"
    );
  }
  if (!current || hashBytes(current) !== expectedHash) {
    await pruneManagedRecoveries(fromUri(destination));
    throw new AtomicWriteFileError(
      `保存先「${fromUri(destination)}」は読み込み後に変更されました。提案内容は手動適用用に「${fromUri(proposal)}」へ残しました。`,
      "modified_externally",
      "not_saved",
      [fromUri(destination), fromUri(proposal)]
    );
  }

  // 公開FS APIには「期待した版なら置換」を一命令で行うCASがない。
  // ここから正規パスへ触れないことで、失敗時に拡張機能が正規ファイルを
  // 消失・上書きしていない、という不変条件を外部保存やクラッシュ越しにも守る。
  await pruneManagedRecoveries(fromUri(destination));
  throw new AtomicWriteFileError(
    `安全に既存ファイルを自動置換できないため保存しませんでした。提案内容を「${fromUri(proposal)}」から手動で反映してください。`,
    "path_conflict",
    "not_saved",
    [fromUri(destination), fromUri(proposal)]
  );
}

async function deleteStagedFileBestEffort(
  file: vscode.Uri,
  expectedHash: string
): Promise<void> {
  try {
    const bytes = await readFileIfExists(file);
    if (!bytes || hashBytes(bytes) !== expectedHash) return;
    await vscode.workspace.fs.delete(file);
  } catch {
    // 同一性を確認できない一時ファイルは残し、本来の競合を呼び出し元へ返す。
  }
}

export async function createManagedRecoveryPath(
  canonicalPath: string
): Promise<string> {
  const directory = recoveryDirectoryFor(canonicalPath);
  await vscode.workspace.fs.createDirectory(path.toUri(directory));
  recoverySequence += 1;
  const timestamp = String(Date.now()).padStart(13, "0");
  const sequence = String(recoverySequence).padStart(8, "0");
  return path.join(
    directory,
    `${recoveryKey(canonicalPath)}-${timestamp}-${sequence}-${randomUuid()}.bak`
  );
}

/** 退避の写しの名前の形。**作る側（上）・整理（下）・一覧（`listManagedRecoveries`）で同じものを見る** */
function managedRecoveryPattern(key: string): RegExp {
  return new RegExp(
    `^${key}-(\\d{13})-\\d{8}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.bak$`,
    "i"
  );
}

export interface ManagedRecoveryEntry {
  /** 写しの場所 */
  path: string;
  /** 退避した時刻（名前の13桁。ミリ秒） */
  timestamp: number;
}

/**
 * そのファイルの退避の写しを、新しいものから並べる（タイムラインの欄。設計書6.119）。
 *
 * **名前の決め方を写さないためにここへ置いた。** 鍵（`recoveryKey`）と
 * 置き場（`recoveryDirectoryFor`）を外で組み直すと、片方を直した日に
 * 写しが見つからなくなる。読めなければ空を返す（欄が出ないだけで済む）。
 */
export async function listManagedRecoveries(
  canonicalPath: string
): Promise<ManagedRecoveryEntry[]> {
  const directory = recoveryDirectoryFor(canonicalPath);
  const pattern = managedRecoveryPattern(recoveryKey(canonicalPath));
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(directory));
  } catch {
    return [];
  }
  const found: ManagedRecoveryEntry[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File) continue;
    const match = pattern.exec(name);
    if (!match) continue;
    found.push({ path: path.join(directory, name), timestamp: Number(match[1]) });
  }
  return found.sort((left, right) => right.timestamp - left.timestamp);
}

export async function pruneManagedRecoveries(
  canonicalPath: string
): Promise<void> {
  const directory = recoveryDirectoryFor(canonicalPath);
  const key = recoveryKey(canonicalPath);
  const pattern = managedRecoveryPattern(key);

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(directory));
  } catch {
    return;
  }

  // 同一ファイルの手動適用用提案は、この拡張機能が作った最新5件だけを残す。
  const obsolete = entries
    .filter(([name, type]) => type === vscode.FileType.File && pattern.test(name))
    .map(([name]) => name)
    .sort((left, right) => right.localeCompare(left))
    .slice(RECOVERY_GENERATIONS_PER_FILE);
  for (const name of obsolete) {
    try {
      await vscode.workspace.fs.delete(path.toUri(path.join(directory, name)));
    } catch {
      // 回復物の整理失敗で、完了済みの保存を失敗扱いにしない。
    }
  }
}

async function readFileIfExists(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

function manualRecoveryError(
  message: string,
  paths: string[],
  persistenceState: AtomicWritePersistenceState
): AtomicWriteFileError {
  return new AtomicWriteFileError(
    `${message} データを失わないため関連ファイルを残しました。手動で確認してください: ${paths.join(
      ", "
    )}`,
    "path_conflict",
    persistenceState,
    paths
  );
}

function recoveryDirectoryFor(canonicalPath: string): string {
  return path.join(path.dirname(canonicalPath), RECOVERY_DIRECTORY_NAME);
}

function recoveryKey(canonicalPath: string): string {
  return sha256Text(path.normalizeForComparison(canonicalPath));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

function isFileExists(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileExists";
}

function hashBytes(bytes: Uint8Array): string {
  return sha256Bytes(bytes);
}
