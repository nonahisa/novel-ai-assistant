import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import {
  Character,
  characterFileName,
  parseCharacter,
} from "../models/character";
import { atomicWriteFile } from "./atomicWrite";
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

export class CharacterStoreError extends Error {
  constructor(
    message: string,
    readonly kind: "modified_externally" | "path_conflict"
  ) {
    super(message);
    this.name = "CharacterStoreError";
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
    for (const item of prepared) {
      await this.persist(item);
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
    await atomicWriteFile(prepared.destinationPath, prepared.bytes);

    const sourcePath = prepared.snapshot?.filePath;
    if (sourcePath && !samePath(sourcePath, prepared.destinationPath)) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(sourcePath));
      } catch (error) {
        try {
          await vscode.workspace.fs.delete(
            vscode.Uri.file(prepared.destinationPath)
          );
        } catch {
          // 正しい旧ファイルを残すことを優先し、元の削除エラーを通知する。
        }
        throw error;
      }
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
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

