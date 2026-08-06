import * as crypto from "crypto";
import * as vscode from "vscode";

export type AtomicWriteFileOptions =
  | { mode: "create" }
  | { mode: "replace"; expectedHash: string };

export class AtomicWriteFileError extends Error {
  constructor(
    message: string,
    readonly kind: "modified_externally" | "path_conflict"
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

  const backup = vscode.Uri.file(`${filePath}.novelai-${nonce}.bak`);
  await replaceGuarded(
    destination,
    temporary,
    backup,
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
      "path_conflict"
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
        "path_conflict"
      );
    }
    throw error;
  }

  const placed = await readFileIfExists(destination);
  if (!placed || hashBytes(placed) !== stagedHash) {
    throw manualRecoveryError(
      `配置直後に保存先「${destination.fsPath}」が変更されました。`,
      [destination.fsPath]
    );
  }
}

async function replaceGuarded(
  destination: vscode.Uri,
  temporary: vscode.Uri,
  backup: vscode.Uri,
  stagedHash: string,
  expectedHash: string
): Promise<void> {
  const current = await readFileIfExists(destination);
  if (!current || hashBytes(current) !== expectedHash) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    throw new AtomicWriteFileError(
      `保存先「${destination.fsPath}」は一時書き込み中に変更されました。`,
      "modified_externally"
    );
  }

  try {
    await vscode.workspace.fs.rename(destination, backup, { overwrite: false });
  } catch (error) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    if (isFileNotFound(error)) {
      throw new AtomicWriteFileError(
        `保存先「${destination.fsPath}」は一時書き込み中に変更されました。`,
        "modified_externally"
      );
    }
    throw manualRecoveryError(
      `元ファイルを回復パスへ移動できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath]
    );
  }

  let backedUp: Uint8Array | undefined;
  try {
    backedUp = await readFileIfExists(backup);
  } catch (error) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    throw manualRecoveryError(
      `回復ファイルを確認できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath]
    );
  }
  if (!backedUp || hashBytes(backedUp) !== expectedHash) {
    await deleteStagedFileBestEffort(temporary, stagedHash);
    throw manualRecoveryError(
      `回復ファイルが読み込み時の内容と一致しません。`,
      [destination.fsPath, backup.fsPath]
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
      [destination.fsPath, backup.fsPath]
    );
  }

  let placed: Uint8Array | undefined;
  try {
    placed = await readFileIfExists(destination);
  } catch (error) {
    throw manualRecoveryError(
      `配置したファイルを確認できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath]
    );
  }
  if (!placed || hashBytes(placed) !== stagedHash) {
    throw manualRecoveryError(
      `配置したファイルが直後に変更されました。`,
      [destination.fsPath, backup.fsPath]
    );
  }

  let recovery: Uint8Array | undefined;
  try {
    recovery = await readFileIfExists(backup);
  } catch (error) {
    throw manualRecoveryError(
      `回復ファイルを再確認できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath]
    );
  }
  if (!recovery || hashBytes(recovery) !== expectedHash) {
    throw manualRecoveryError(
      `回復ファイルが変更されたため保持します。`,
      [destination.fsPath, backup.fsPath]
    );
  }

  let finalPlaced: Uint8Array | undefined;
  try {
    finalPlaced = await readFileIfExists(destination);
  } catch (error) {
    throw manualRecoveryError(
      `回復ファイル確認後に保存先を再確認できませんでした: ${errorMessage(error)}`,
      [destination.fsPath, backup.fsPath]
    );
  }
  if (!finalPlaced || hashBytes(finalPlaced) !== stagedHash) {
    throw manualRecoveryError(
      `回復ファイル確認中に保存先が変更されました。`,
      [destination.fsPath, backup.fsPath]
    );
  }
}

async function deleteStagedFileBestEffort(
  file: vscode.Uri,
  expectedHash: string
): Promise<void> {
  const bytes = await readFileIfExists(file);
  if (!bytes || hashBytes(bytes) !== expectedHash) return;
  try {
    await vscode.workspace.fs.delete(file);
  } catch {
    // 一時ファイルの回収より、呼び出し元へ本来の競合を返すことを優先する。
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

function manualRecoveryError(message: string, paths: string[]): AtomicWriteFileError {
  return new AtomicWriteFileError(
    `${message} データを失わないため関連ファイルを残しました。手動で確認してください: ${paths.join(
      ", "
    )}`,
    "path_conflict"
  );
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
