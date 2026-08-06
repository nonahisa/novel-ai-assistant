import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import {
  Character,
  characterFileName,
  parseCharacter,
} from "../models/character";
import {
  AtomicWriteFileError,
  atomicWriteFile,
  createManagedRecoveryPath,
  pruneManagedRecoveries,
} from "./atomicWrite";
import { hashBytes } from "./textFile";

interface CharacterSnapshot {
  filePath: string;
  hash: string;
}

interface PreparedCharacterSave {
  character: Character;
  destinationPath: string;
  snapshot: CharacterSnapshot | undefined;
  bytes: Uint8Array;
}

/** saveAll 失敗時の相互排他的な永続化結果。 */
export interface CharacterStoreBatchProgress {
  /** persist が最後まで完了した人物。 */
  completedIds: string[];
  /** 関連ファイルを残しており、保存成否を手動確認する人物。 */
  ambiguousIds: string[];
  /** 現在件の保存前競合と、まだ処理していない人物。 */
  remainingIds: string[];
}

export type CharacterPersistenceState = "not_saved" | "ambiguous";

interface CharacterStoreErrorOptions {
  persistenceState?: CharacterPersistenceState;
  batchProgress?: CharacterStoreBatchProgress;
}

export class CharacterStoreError extends Error {
  readonly persistenceState: CharacterPersistenceState;
  readonly batchProgress: CharacterStoreBatchProgress | undefined;

  constructor(
    message: string,
    readonly kind: "modified_externally" | "path_conflict",
    options: CharacterStoreErrorOptions = {}
  ) {
    super(message);
    this.name = "CharacterStoreError";
    this.persistenceState = options.persistenceState ?? "not_saved";
    this.batchProgress = options.batchProgress;
  }
}

/**
 * 登場人物の保存先。
 *
 * 1人1ファイルに分割している。大きな characters.json ひとつだと、
 * 別環境で別々の人物を追記しただけで競合するため。
 * ファイル名に人名を含めるのは、GitHubの差分画面で
 * 何の変更か判別できるようにするため。
 */
export class CharacterStore {
  private readonly snapshots = new Map<string, CharacterSnapshot>();

  constructor(private readonly work: WorkEntry) {}

  private async dir(): Promise<string> {
    const config = await readWorkConfig(this.work);
    return path.join(workPaths(this.work, config).settings, "characters");
  }

  async ensureDir(): Promise<string> {
    const d = await this.dir();
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(d));
    return d;
  }

  /** 全人物を読み込む。壊れたJSONは読み飛ばし、エラーとして返す */
  async loadAll(): Promise<{
    characters: Character[];
    errors: Array<{ file: string; message: string }>;
  }> {
    this.snapshots.clear();
    const d = await this.dir();
    const characters: Character[] = [];
    const errors: Array<{ file: string; message: string }> = [];
    const loadedIds = new Set<string>();
    const loadedSnapshots = new Map<string, CharacterSnapshot>();

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(d));
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        return { characters, errors };
      }
      throw error;
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      if (!name.endsWith(".json")) continue;
      if (name.startsWith("_")) continue; // _index.json など

      const full = path.join(d, name);
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.file(full)
        );
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const character = parseCharacter(parsed);
        if (name !== `${character.id}.json` && !name.startsWith(`${character.id}_`)) {
          throw new Error(`ファイル名と人物ID「${character.id}」が一致しません。`);
        }
        if (loadedIds.has(character.id)) {
          loadedSnapshots.delete(character.id);
          throw new Error(`人物ID「${character.id}」が重複しています。`);
        }
        loadedIds.add(character.id);
        characters.push(character);
        loadedSnapshots.set(character.id, {
          filePath: full,
          hash: hashBytes(bytes),
        });
      } catch (e) {
        // 作者が手で編集して壊れた可能性がある。
        // 勝手に修復・上書きせず、エラーとして報告する。
        errors.push({
          file: name,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    for (const [id, snapshot] of loadedSnapshots) {
      this.snapshots.set(id, snapshot);
    }
    characters.sort((a, b) => a.id.localeCompare(b.id));
    return { characters, errors };
  }

  async save(character: Character): Promise<void> {
    const validated = parseCharacter(character);
    const prepared = await this.prepareSave(validated);
    await this.ensureDir();
    await this.persist(prepared);
  }

  async saveAll(characters: Character[]): Promise<void> {
    const validated = characters.map((character) => parseCharacter(character));
    const requestedIds = new Set<string>();
    for (const character of validated) {
      if (requestedIds.has(character.id)) {
        throw new CharacterStoreError(
          `人物ID「${character.id}」が保存対象内で重複しています。`,
          "path_conflict"
        );
      }
      requestedIds.add(character.id);
    }

    // 既知の競合で一部だけ保存されないよう、全件を最初に検証する。
    const prepared = await Promise.all(
      validated.map((character) => this.prepareSave(character))
    );
    if (prepared.length > 0) {
      await this.ensureDir();
    }
    const completedIds: string[] = [];
    for (let index = 0; index < prepared.length; index++) {
      const item = prepared[index];
      try {
        await this.persist(item);
        completedIds.push(item.character.id);
      } catch (error) {
        if (!(error instanceof CharacterStoreError)) throw error;
        const ambiguous = error.persistenceState === "ambiguous";
        throw new CharacterStoreError(error.message, error.kind, {
          persistenceState: error.persistenceState,
          batchProgress: {
            completedIds: [...completedIds],
            ambiguousIds: ambiguous ? [item.character.id] : [],
            remainingIds: [
              ...(!ambiguous ? [item.character.id] : []),
              ...prepared
                .slice(index + 1)
                .map((pending) => pending.character.id),
            ],
          },
        });
      }
    }
  }

  private async prepareSave(
    character: Character
  ): Promise<PreparedCharacterSave> {
    const d = await this.dir();
    const destinationPath = path.join(d, characterFileName(character));
    const snapshot = this.snapshots.get(character.id);
    await this.assertSaveAllowed(character.id, destinationPath, snapshot);

    const body = JSON.stringify(
      { ...character, updatedAt: new Date().toISOString() },
      null,
      2
    );
    return {
      character,
      destinationPath,
      snapshot,
      bytes: new TextEncoder().encode(`${body}\n`),
    };
  }

  private async persist(prepared: PreparedCharacterSave): Promise<void> {
    // preflight 後の外部編集も拾うため、置換の直前にもう一度確認する。
    await this.assertSaveAllowed(
      prepared.character.id,
      prepared.destinationPath,
      prepared.snapshot
    );
    const snapshot = prepared.snapshot;
    const sourcePath = snapshot?.filePath;
    try {
      await atomicWriteFile(
        prepared.destinationPath,
        prepared.bytes,
        sourcePath && samePath(sourcePath, prepared.destinationPath)
          ? { mode: "replace", expectedHash: snapshot.hash }
          : { mode: "create" }
      );
    } catch (error) {
      if (error instanceof AtomicWriteFileError) {
        throw new CharacterStoreError(error.message, error.kind, {
          persistenceState: error.persistenceState,
        });
      }
      throw error;
    }

    if (snapshot && sourcePath && !samePath(sourcePath, prepared.destinationPath)) {
      const sourceBeforeRetire = await this.readFileIfExists(sourcePath);
      if (
        !sourceBeforeRetire ||
        hashBytes(sourceBeforeRetire) !== snapshot.hash
      ) {
        throw this.manualRecoveryError(
          `人物「${prepared.character.id}」の旧ファイルが新しい保存先の配置中に変更されました。`,
          [sourcePath, prepared.destinationPath]
        );
      }

      let recoveryPath: string;
      try {
        recoveryPath = await createManagedRecoveryPath(sourcePath);
      } catch (error) {
        throw this.manualRecoveryError(
          `旧ファイルの回復先を準備できませんでした: ${errorMessage(error)}`,
          [sourcePath, prepared.destinationPath]
        );
      }
      try {
        await vscode.workspace.fs.rename(
          vscode.Uri.file(sourcePath),
          vscode.Uri.file(recoveryPath),
          { overwrite: false }
        );
      } catch (error) {
        throw this.manualRecoveryError(
          `旧ファイルを回復パスへ移動できませんでした: ${errorMessage(error)}`,
          [sourcePath, prepared.destinationPath, recoveryPath]
        );
      }

      let recoveryBytes: Uint8Array | undefined;
      try {
        recoveryBytes = await this.readFileIfExists(recoveryPath);
      } catch (error) {
        throw this.manualRecoveryError(
          `回復ファイルを確認できませんでした: ${errorMessage(error)}`,
          [prepared.destinationPath, recoveryPath]
        );
      }
      if (!recoveryBytes || hashBytes(recoveryBytes) !== snapshot.hash) {
        throw this.manualRecoveryError(
          `回復ファイルが読み込み時の旧内容と一致しません。`,
          [prepared.destinationPath, recoveryPath]
        );
      }

      let destinationBytes: Uint8Array | undefined;
      try {
        destinationBytes = await this.readFileIfExists(prepared.destinationPath);
      } catch (error) {
        throw this.manualRecoveryError(
          `旧ファイル退避後に新しい保存先を確認できませんでした: ${errorMessage(error)}`,
          [prepared.destinationPath, recoveryPath]
        );
      }
      if (
        !destinationBytes ||
        hashBytes(destinationBytes) !== hashBytes(prepared.bytes)
      ) {
        throw this.manualRecoveryError(
          `旧ファイル退避後に新しい保存先が変更されました。`,
          [prepared.destinationPath, recoveryPath]
        );
      }

      await pruneManagedRecoveries(sourcePath);
    }

    this.snapshots.set(prepared.character.id, {
      filePath: prepared.destinationPath,
      hash: hashBytes(prepared.bytes),
    });
  }

  private async assertSaveAllowed(
    id: string,
    destinationPath: string,
    snapshot: CharacterSnapshot | undefined
  ): Promise<void> {
    const filesById = await this.findFilesById(id);

    if (!snapshot) {
      if (filesById.length > 0 || await this.fileExists(destinationPath)) {
        throw new CharacterStoreError(
          `人物「${id}」の保存先はすでに存在します。`,
          "path_conflict"
        );
      }
      return;
    }

    const currentBytes = await this.readFileIfExists(snapshot.filePath);
    if (!currentBytes || hashBytes(currentBytes) !== snapshot.hash) {
      throw new CharacterStoreError(
        `人物「${id}」は読み込み後に変更されています。`,
        "modified_externally"
      );
    }

    if (filesById.some((filePath) => !samePath(filePath, snapshot.filePath))) {
      throw new CharacterStoreError(
        `人物「${id}」と同じIDのファイルが別に存在します。`,
        "path_conflict"
      );
    }

    if (
      !samePath(snapshot.filePath, destinationPath) &&
      await this.fileExists(destinationPath)
    ) {
      throw new CharacterStoreError(
        `人物「${id}」の名前変更先はすでに存在します。`,
        "path_conflict"
      );
    }
  }

  private async findFilesById(id: string): Promise<string[]> {
    const d = await this.dir();
    const found: string[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(d)
      );
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
        if (name.startsWith(`${id}_`) || name === `${id}.json`) {
          found.push(path.join(d, name));
        }
      }
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") {
        throw error;
      }
      // ディレクトリが無い場合は該当なし
    }
    return found;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    return (await this.readFileIfExists(filePath)) !== undefined;
  }

  private async readFileIfExists(
    filePath: string
  ): Promise<Uint8Array | undefined> {
    try {
      return await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        return undefined;
      }
      throw error;
    }
  }

  private manualRecoveryError(
    message: string,
    paths: string[]
  ): CharacterStoreError {
    return new CharacterStoreError(
      `${message} データを失わないため回復可能なファイルを残しました。手動で確認してください: ${paths.join(
        ", "
      )}`,
      "path_conflict",
      { persistenceState: "ambiguous" }
    );
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

