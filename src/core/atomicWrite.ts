import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";

export const RECOVERY_GENERATIONS_PER_FILE = 5;
const RECOVERY_DIRECTORY_NAME = ".novelai-recovery";
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
 * 同じディレクトリ内で置換することで、書き込み途中の原稿を残さない。
 * ガード指定時は一時書き込み後にも競合を検証し、既存ファイルを退避してから配置する。
 */
export async function atomicWriteFile(
  filePath: string,
  bytes: Uint8Array,
  options?: AtomicWriteFileOptions
): Promise<void> {
  const destination = vscode.Uri.file(filePath);
  const nonce = `${process.pid}-${crypto.randomUUID()}`;
  const temporary = vscode.Uri.file(`${filePath}.novelai-${nonce}.tmp`);
  const stagedHash = hashBytes(bytes);

  await vscode.workspace.fs.writeFile(temporary, bytes);

  if (!options) {
    try {
      await vscode.workspace.fs.rename(temporary, destination, { overwrite: true });
    } catch (error) {
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

async function placeNewFile(
  destination: vscode.Uri,
  temporary: vscode.Uri,
  stagedHash: string
): Promise<void> {
  if (await readFileIfExists(destination)) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    throw new AtomicWriteFileError(
      `保存先「${destination.fsPath}」は一時書き込み中に作成されました。`,
      "path_conflict",
      "not_saved",
      [destination.fsPath, temporary.fsPath]
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
        `保存先「${destination.fsPath}」が同時に作成されました。`,
        "path_conflict",
        "not_saved",
        [destination.fsPath, temporary.fsPath]
      );
    }
    throw error;
  }

  const placed = await readFileIfExists(destination);
  if (!placed || hashBytes(placed) !== stagedHash) {
    throw manualRecoveryError(
      `配置直後に保存先「${destination.fsPath}」が変更されました。`,
      [destination.fsPath],
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
  const current = await readFileIfExists(destination);
  if (!current || hashBytes(current) !== expectedHash) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    throw new AtomicWriteFileError(
      `保存先「${destination.fsPath}」は一時書き込み中に変更されました。`,
      "modified_externally",
      "not_saved",
      [destination.fsPath, temporary.fsPath]
    );
  }

  let backup: vscode.Uri;
  try {
    backup = vscode.Uri.file(await createManagedRecoveryPath(destination.fsPath));
  } catch (error) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    throw manualRecoveryError(
      `回復ディレクトリを準備できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, recoveryDirectoryFor(destination.fsPath), temporary.fsPath],
      "ambiguous"
    );
  }

  try {
    await vscode.workspace.fs.rename(destination, backup, { overwrite: false });
  } catch (error) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    if (isFileNotFound(error)) {
      throw new AtomicWriteFileError(
        `保存先「${destination.fsPath}」は一時書き込み中に変更されました。`,
        "modified_externally",
        "not_saved",
        [destination.fsPath, temporary.fsPath]
      );
    }
    throw manualRecoveryError(
      `元ファイルを回復パスへ移動できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath],
      "ambiguous"
    );
  }

  let backedUp: Uint8Array | undefined;
  try {
    backedUp = await readFileIfExists(backup);
  } catch (error) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    throw manualRecoveryError(
      `回復ファイルを確認できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath],
      "ambiguous"
    );
  }
  if (!backedUp || hashBytes(backedUp) !== expectedHash) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    throw manualRecoveryError(
      `回復ファイルが読み込み時の内容と一致しません。`,
      [destination.fsPath, backup.fsPath],
      "ambiguous"
    );
  }

  try {
    await vscode.workspace.fs.rename(temporary, destination, {
      overwrite: false,
    });
  } catch (error) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    throw manualRecoveryError(
      `新しい内容を配置できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath],
      "ambiguous"
    );
  }

  let placed: Uint8Array | undefined;
  try {
    placed = await readFileIfExists(destination);
  } catch (error) {
    throw manualRecoveryError(
      `配置したファイルを確認できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath],
      "ambiguous"
    );
  }
  if (!placed || hashBytes(placed) !== stagedHash) {
    throw manualRecoveryError(
      `配置したファイルが直後に変更されました。`,
      [destination.fsPath, backup.fsPath],
      "ambiguous"
    );
  }

  let recovery: Uint8Array | undefined;
  try {
    recovery = await readFileIfExists(backup);
  } catch (error) {
    throw manualRecoveryError(
      `回復ファイルを再確認できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath],
      "ambiguous"
    );
  }
  if (!recovery || hashBytes(recovery) !== expectedHash) {
    throw manualRecoveryError(
      `回復ファイルが変更されたため保持します。`,
      [destination.fsPath, backup.fsPath],
      "ambiguous"
    );
  }

  let finalPlaced: Uint8Array | undefined;
  try {
    finalPlaced = await readFileIfExists(destination);
  } catch (error) {
    throw manualRecoveryError(
      `回復ファイル確認後に保存先を再確認できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath],
      "ambiguous"
    );
  }
  if (!finalPlaced || hashBytes(finalPlaced) !== stagedHash) {
    throw manualRecoveryError(
      `回復ファイル確認中に保存先が変更されました。`,
      [destination.fsPath, backup.fsPath],
      "ambiguous"
    );
  }

  await pruneManagedRecoveries(destination.fsPath);
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
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
  recoverySequence += 1;
  const timestamp = String(Date.now()).padStart(13, "0");
  const sequence = String(recoverySequence).padStart(8, "0");
  return path.join(
    directory,
    `${recoveryKey(canonicalPath)}-${timestamp}-${sequence}-${crypto.randomUUID()}.bak`
  );
}

export async function pruneManagedRecoveries(
  canonicalPath: string
): Promise<void> {
  const directory = recoveryDirectoryFor(canonicalPath);
  const key = recoveryKey(canonicalPath);
  const pattern = new RegExp(
    `^${key}-\\d{13}-\\d{8}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.bak$`,
    "i"
  );

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(directory));
  } catch {
    return;
  }

  // 正常保存後だけ、この拡張機能が作った同一ファイルの最新5世代を残す。
  const obsolete = entries
    .filter(([name, type]) => type === vscode.FileType.File && pattern.test(name))
    .map(([name]) => name)
    .sort((left, right) => right.localeCompare(left))
    .slice(RECOVERY_GENERATIONS_PER_FILE);
  for (const name of obsolete) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(path.join(directory, name)));
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
  const normalized = path.normalize(vscode.Uri.file(canonicalPath).fsPath);
  const stablePath = process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
  return crypto.createHash("sha256").update(stablePath, "utf8").digest("hex");
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
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
