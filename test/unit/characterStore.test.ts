import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  CharacterStore,
  CharacterStoreError,
} from "../../src/core/characterStore";
import {
  characterFileName,
  emptyCharacter,
  parseCharacter,
  type Character,
} from "../../src/models/character";
import type { WorkEntry } from "../../src/models/types";
import {
  FileSystemError,
  FileType,
  Uri,
  workspace,
} from "./support/vscodeStub";

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-08-06T00:00:00.000Z",
};

const characterDir = diskPath(
  path.join(work.folderPath, "設定", "characters")
);

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesFor(character: Character): Uint8Array {
  return utf8(`${JSON.stringify(character, null, 2)}\n`);
}

function fixedCharacter(id: string, name: string): Character {
  return {
    ...emptyCharacter(id, name),
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
}

describe("人物ファイル保存", () => {
  const disk = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  let rename: ReturnType<typeof vi.fn>;
  let remove: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disk.clear();
    directories.clear();
    directories.add(characterDir);
    workspace.textDocuments = [];

    rename = vi.fn(
      async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      }
    );
    remove = vi.fn(async (uri: { fsPath: string }) => {
      if (!disk.delete(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
    });

    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        directories.add(uri.fsPath);
      },
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      readDirectory: async (uri: { fsPath: string }) => {
        if (!directories.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return [...disk.keys()]
          .filter((filePath) => path.dirname(filePath) === uri.fsPath)
          .map((filePath) => [path.basename(filePath), FileType.File] as [string, FileType]);
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename,
      delete: remove,
    };
  });

  test("読み込み後に作者が編集した人物を上書きしない", async () => {
    const original = fixedCharacter("char_001", "灯");
    const characterPath = diskPath(path.join(characterDir, characterFileName(original)));
    disk.set(characterPath, bytesFor(original));
    const store = new CharacterStore(work);
    await store.loadAll();
    const changedByAuthorBytes = bytesFor({
      ...original,
      authorNotes: "AI処理中に作者が追記",
    });
    disk.set(characterPath, changedByAuthorBytes);

    await expect(
      store.save({ ...original, personality: "AIが更新" })
    ).rejects.toMatchObject({
      kind: "modified_externally",
      batchProgress: undefined,
    });

    expect(rename).not.toHaveBeenCalled();
    expect(disk.get(characterPath)).toEqual(changedByAuthorBytes);
  });

  test("大文字小文字が異なるWindowsパスの未保存人物JSONを拒否する", async () => {
    const original = fixedCharacter("char_001", "灯");
    const characterPath = diskPath(path.join(characterDir, characterFileName(original)));
    const originalBytes = bytesFor(original);
    disk.set(characterPath, originalBytes);
    const store = new CharacterStore(work);
    await store.loadAll();
    workspace.textDocuments = [{
      uri: Uri.file(characterPath.toUpperCase()),
      isDirty: true,
      getText: () => "作者が編集中",
      save: vi.fn(async () => false),
    }];

    await expect(
      store.save({ ...original, personality: "AIが更新" })
    ).rejects.toMatchObject({
      kind: "unsaved_changes",
      persistenceState: "not_saved",
    });

    expect(rename).not.toHaveBeenCalled();
    expect(disk.get(characterPath)).toEqual(originalBytes);
  });

  test("名前変更先に別ファイルがある場合は両方を残す", async () => {
    const original = fixedCharacter("char_001", "旧名");
    const renamed = { ...original, name: "新名" };
    const oldPath = diskPath(path.join(characterDir, characterFileName(original)));
    const newPath = diskPath(path.join(characterDir, characterFileName(renamed)));
    const originalBytes = bytesFor(original);
    const unrelatedBytes = utf8('{"作者":"別ファイル"}\n');
    disk.set(oldPath, originalBytes);
    const store = new CharacterStore(work);
    await store.loadAll();
    disk.set(newPath, unrelatedBytes);

    await expect(store.save(renamed)).rejects.toMatchObject({
      kind: "path_conflict",
    });

    expect(disk.get(oldPath)).toEqual(originalBytes);
    expect(disk.get(newPath)).toEqual(unrelatedBytes);
    expect(rename).not.toHaveBeenCalled();
  });

  test("保存前に全人物を検証し既知の競合で一部だけ更新しない", async () => {
    const first = fixedCharacter("char_001", "灯");
    const second = fixedCharacter("char_002", "澪");
    const firstPath = diskPath(path.join(characterDir, characterFileName(first)));
    const secondPath = diskPath(path.join(characterDir, characterFileName(second)));
    const firstBytes = bytesFor(first);
    disk.set(firstPath, firstBytes);
    disk.set(secondPath, bytesFor(second));
    const store = new CharacterStore(work);
    await store.loadAll();
    disk.set(secondPath, bytesFor({ ...second, exportNote: "作者の追記" }));

    await expect(
      store.saveAll([
        { ...first, personality: "先に更新されるはずだった人物" },
        { ...second, personality: "競合する人物" },
      ])
    ).rejects.toMatchObject({
      kind: "modified_externally",
      batchProgress: undefined,
    });

    expect(rename).not.toHaveBeenCalled();
    expect(disk.get(firstPath)).toEqual(firstBytes);
  });

  test("後続人物の直前競合では先に完了した人物と未保存人物を分けて返す", async () => {
    const first = fixedCharacter("char_001", "灯");
    const second = fixedCharacter("char_002", "澪");
    const firstPath = diskPath(path.join(characterDir, characterFileName(first)));
    const secondPath = diskPath(path.join(characterDir, characterFileName(second)));
    disk.set(secondPath, bytesFor(second));
    const store = new CharacterStore(work);
    await store.loadAll();
    const secondChangedByAuthor = bytesFor({
      ...second,
      authorNotes: "1件目の保存中に作者が追記",
    });
    rename.mockImplementation(
      async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
        if (to.fsPath === firstPath && from.fsPath.endsWith(".tmp")) {
          disk.set(secondPath, secondChangedByAuthor);
        }
      }
    );

    await expect(
      store.saveAll([
        { ...first, personality: "保存完了" },
        { ...second, personality: "保存されない" },
      ])
    ).rejects.toMatchObject({
      kind: "modified_externally",
      batchProgress: {
        completedIds: ["char_001"],
        ambiguousIds: [],
        remainingIds: ["char_002"],
      },
    });

    expect(
      JSON.parse(new TextDecoder().decode(disk.get(firstPath)))
    ).toMatchObject({ personality: "保存完了" });
    expect(disk.get(secondPath)).toEqual(secondChangedByAuthor);
  });

  test("先行保存後の新規保存先衝突は現在人物を曖昧でなく未保存にする", async () => {
    const first = fixedCharacter("char_001", "灯");
    const second = fixedCharacter("char_002", "澪");
    const firstPath = diskPath(path.join(characterDir, characterFileName(first)));
    const secondPath = diskPath(path.join(characterDir, characterFileName(second)));
    const createdByAuthor = utf8('{"作者":"同時に作成"}\n');
    const store = new CharacterStore(work);
    await store.loadAll();
    const originalWriteFile = workspace.fs.writeFile;
    workspace.fs.writeFile = vi.fn(
      async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await originalWriteFile(uri, bytes);
        if (uri.fsPath.startsWith(`${secondPath}.novelai-`)) {
          disk.set(secondPath, createdByAuthor);
        }
      }
    );

    await expect(store.saveAll([first, second])).rejects.toMatchObject({
      kind: "path_conflict",
      persistenceState: "not_saved",
      batchProgress: {
        completedIds: ["char_001"],
        ambiguousIds: [],
        remainingIds: ["char_002"],
      },
    });

    expect(disk.has(firstPath)).toBe(true);
    expect(disk.get(secondPath)).toEqual(createdByAuthor);
  });

  test("先行保存後の生のステージ書込失敗を型付き進捗へ変換する", async () => {
    const first = fixedCharacter("char_001", "灯");
    const second = fixedCharacter("char_002", "澪");
    const firstPath = diskPath(path.join(characterDir, characterFileName(first)));
    const secondPath = diskPath(path.join(characterDir, characterFileName(second)));
    const baseWriteFile = workspace.fs.writeFile;
    workspace.fs.writeFile = vi.fn(async (uri, bytes) => {
      if (uri.fsPath.startsWith(`${secondPath}.novelai-`)) {
        throw new FileSystemError("staging denied", "NoPermissions");
      }
      await baseWriteFile(uri, bytes);
    });
    const store = new CharacterStore(work);
    await store.loadAll();

    await expect(store.saveAll([first, second])).rejects.toMatchObject({
      kind: "io_error",
      persistenceState: "not_saved",
      batchProgress: {
        completedIds: ["char_001"],
        ambiguousIds: [],
        remainingIds: ["char_002"],
      },
    });

    expect(disk.has(firstPath)).toBe(true);
    expect(disk.has(secondPath)).toBe(false);
  });

  test("既存人物の自動置換をせず作者項目を保った提案内容を回復パスへ残す", async () => {
    const original = {
      ...fixedCharacter("char_001", "灯"),
      authorNotes: "作者メモ",
      exportNote: "公開用注記",
    };
    const characterPath = diskPath(path.join(characterDir, characterFileName(original)));
    const originalBytes = bytesFor(original);
    disk.set(characterPath, originalBytes);
    const store = new CharacterStore(work);
    const loaded = await store.loadAll();

    let saveError: CharacterStoreError | undefined;
    try {
      await store.save(loaded.characters[0]);
    } catch (error) {
      expect(error).toBeInstanceOf(CharacterStoreError);
      saveError = error as CharacterStoreError;
    }

    expect(saveError).toMatchObject({
      kind: "path_conflict",
      persistenceState: "not_saved",
      recoveryPaths: expect.arrayContaining([characterPath]),
    });
    expect(disk.get(characterPath)).toEqual(originalBytes);
    const proposalPath = saveError?.recoveryPaths.find(
      (filePath) => filePath !== characterPath
    );
    expect(proposalPath).toBeDefined();

    const proposal = JSON.parse(
      new TextDecoder().decode(disk.get(proposalPath!))
    ) as Record<string, unknown>;
    expect(proposal).toMatchObject({
      authorNotes: "作者メモ",
      exportNote: "公開用注記",
    });
  });

  test("同じパスの未保存提案より先に独立した名前変更と新規人物を完了する", async () => {
    const samePath = fixedCharacter("char_001", "灯");
    const renameSource = fixedCharacter("char_002", "旧名");
    const renamed = { ...renameSource, name: "新名" };
    const created = fixedCharacter("char_003", "新規");
    const samePathFile = diskPath(
      path.join(characterDir, characterFileName(samePath))
    );
    const renameSourceFile = diskPath(
      path.join(characterDir, characterFileName(renameSource))
    );
    const renamedFile = diskPath(
      path.join(characterDir, characterFileName(renamed))
    );
    const createdFile = diskPath(
      path.join(characterDir, characterFileName(created))
    );
    const samePathBytes = bytesFor(samePath);
    const renameSourceBytes = bytesFor(renameSource);
    disk.set(samePathFile, samePathBytes);
    disk.set(renameSourceFile, renameSourceBytes);
    const store = new CharacterStore(work);
    await store.loadAll();

    let saveError: CharacterStoreError | undefined;
    try {
      await store.saveAll([
        { ...samePath, personality: "手動適用する更新" },
        renamed,
        created,
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(CharacterStoreError);
      saveError = error as CharacterStoreError;
    }

    expect(saveError).toMatchObject({
      kind: "path_conflict",
      persistenceState: "not_saved",
      recoveryPaths: expect.arrayContaining([samePathFile]),
      batchProgress: {
        completedIds: ["char_002", "char_003"],
        ambiguousIds: [],
        remainingIds: ["char_001"],
      },
    });
    const progress = saveError?.batchProgress;
    expect(new Set([
      ...(progress?.completedIds ?? []),
      ...(progress?.ambiguousIds ?? []),
      ...(progress?.remainingIds ?? []),
    ]).size).toBe(3);
    expect(disk.get(samePathFile)).toEqual(samePathBytes);
    const proposalPath = saveError?.recoveryPaths.find(
      (filePath) => filePath !== samePathFile
    );
    expect(proposalPath).toBeDefined();
    expect(
      JSON.parse(new TextDecoder().decode(disk.get(proposalPath!)))
    ).toMatchObject({ personality: "手動適用する更新" });
    expect(disk.has(renameSourceFile)).toBe(false);
    expect(disk.has(renamedFile)).toBe(true);
    expect(disk.has(createdFile)).toBe(true);
    expect(
      [...disk.entries()].some(
        ([filePath, bytes]) =>
          path.dirname(filePath).endsWith(".novelai-recovery") &&
          bytes === renameSourceBytes
      )
    ).toBe(true);
  });

  test("新規人物の保存先が読み込み後に作られた場合は上書きしない", async () => {
    const created = fixedCharacter("char_003", "灯");
    const characterPath = diskPath(path.join(characterDir, characterFileName(created)));
    const unrelatedBytes = utf8('{"作者":"先に作成"}\n');
    const store = new CharacterStore(work);
    await store.loadAll();
    disk.set(characterPath, unrelatedBytes);

    await expect(store.save(created)).rejects.toMatchObject({
      kind: "path_conflict",
    });

    expect(disk.get(characterPath)).toEqual(unrelatedBytes);
    expect(rename).not.toHaveBeenCalled();
  });

  test("名前変更後も旧内容を一意な回復ファイルに残す", async () => {
    const original = fixedCharacter("char_001", "旧名");
    const renamed = { ...original, name: "新名" };
    const oldPath = diskPath(path.join(characterDir, characterFileName(original)));
    const newPath = diskPath(path.join(characterDir, characterFileName(renamed)));
    const originalBytes = bytesFor(original);
    disk.set(oldPath, originalBytes);
    const store = new CharacterStore(work);
    await store.loadAll();

    await store.save(renamed);

    expect(disk.has(oldPath)).toBe(false);
    expect(disk.has(newPath)).toBe(true);
    const recoveryBytes = [...disk.entries()].find(
      ([filePath]) =>
        path.dirname(filePath).endsWith(".novelai-recovery") &&
        filePath.endsWith(".bak")
    )?.[1];
    expect(recoveryBytes).toEqual(originalBytes);
  });

  test("旧ファイル確認直後の作者編集を削除せず回復ファイルに残す", async () => {
    const original = fixedCharacter("char_001", "旧名");
    const renamed = { ...original, name: "新名" };
    const oldPath = diskPath(path.join(characterDir, characterFileName(original)));
    const newPath = diskPath(path.join(characterDir, characterFileName(renamed)));
    const changedByAuthorBytes = bytesFor({
      ...original,
      authorNotes: "保存先の配置中に作者が追記",
    });
    disk.set(oldPath, bytesFor(original));
    const store = new CharacterStore(work);
    await store.loadAll();
    const originalReadFile = workspace.fs.readFile;
    let changedAfterCheck = false;
    workspace.fs.readFile = vi.fn(async (uri: { fsPath: string }) => {
      const bytes = await originalReadFile(uri);
      if (
        uri.fsPath === oldPath &&
        disk.has(newPath) &&
        !changedAfterCheck
      ) {
        changedAfterCheck = true;
        disk.set(oldPath, changedByAuthorBytes);
      }
      return bytes;
    });

    await expect(store.save(renamed)).rejects.toMatchObject({
      kind: "path_conflict",
      message: expect.stringContaining("手動"),
    });

    expect(disk.has(newPath)).toBe(true);
    const recoveryBytes = [...disk.entries()].find(
      ([filePath]) =>
        path.dirname(filePath).endsWith(".novelai-recovery") &&
        filePath.endsWith(".bak")
    )?.[1];
    expect(recoveryBytes).toEqual(changedByAuthorBytes);
  });

  test("旧ファイルを回復パスへ移動できない場合は両方を残して通知する", async () => {
    const original = fixedCharacter("char_001", "旧名");
    const renamed = { ...original, name: "新名" };
    const oldPath = diskPath(path.join(characterDir, characterFileName(original)));
    const newPath = diskPath(path.join(characterDir, characterFileName(renamed)));
    const originalBytes = bytesFor(original);
    disk.set(oldPath, originalBytes);
    const store = new CharacterStore(work);
    await store.loadAll();
    rename.mockImplementation(
      async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        if (from.fsPath === oldPath && to.fsPath.endsWith(".bak")) {
          throw new FileSystemError("旧ファイルを退避できません", "NoPermissions");
        }
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      }
    );

    await expect(store.save(renamed)).rejects.toMatchObject({
      kind: "path_conflict",
      message: expect.stringContaining("手動"),
    });

    expect(disk.get(oldPath)).toEqual(originalBytes);
    expect(disk.has(newPath)).toBe(true);
  });

  test("名前変更先の配置後に旧ファイル退避が失敗した人物を手動確認扱いにする", async () => {
    const original = fixedCharacter("char_001", "旧名");
    const renamed = { ...original, name: "新名" };
    const oldPath = diskPath(path.join(characterDir, characterFileName(original)));
    const newPath = diskPath(path.join(characterDir, characterFileName(renamed)));
    const originalBytes = bytesFor(original);
    disk.set(oldPath, originalBytes);
    const store = new CharacterStore(work);
    await store.loadAll();
    rename.mockImplementation(
      async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        if (from.fsPath === oldPath && to.fsPath.endsWith(".bak")) {
          throw new FileSystemError("旧ファイルを退避できません", "NoPermissions");
        }
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      }
    );

    await expect(store.saveAll([renamed])).rejects.toMatchObject({
      kind: "path_conflict",
      persistenceState: "ambiguous",
      recoveryPaths: expect.arrayContaining([oldPath, newPath]),
      batchProgress: {
        completedIds: [],
        ambiguousIds: ["char_001"],
        remainingIds: [],
      },
    });

    expect(disk.get(oldPath)).toEqual(originalBytes);
    expect(disk.has(newPath)).toBe(true);
  });

  test("先行保存後に名前変更元を読めなければ現在人物を曖昧、後続を未保存に分ける", async () => {
    const original = fixedCharacter("char_001", "旧名");
    const renamed = { ...original, name: "新名" };
    const first = fixedCharacter("char_002", "先行");
    const pending = fixedCharacter("char_003", "後続");
    const oldPath = diskPath(path.join(characterDir, characterFileName(original)));
    const newPath = diskPath(path.join(characterDir, characterFileName(renamed)));
    const firstPath = diskPath(path.join(characterDir, characterFileName(first)));
    const pendingPath = diskPath(path.join(characterDir, characterFileName(pending)));
    disk.set(oldPath, bytesFor(original));
    const store = new CharacterStore(work);
    await store.loadAll();
    const baseReadFile = workspace.fs.readFile;
    workspace.fs.readFile = vi.fn(async (uri: { fsPath: string }) => {
      if (uri.fsPath === oldPath && disk.has(newPath)) {
        throw new FileSystemError("old path denied", "NoPermissions");
      }
      return baseReadFile(uri);
    });

    await expect(store.saveAll([first, renamed, pending])).rejects.toMatchObject({
      kind: "path_conflict",
      persistenceState: "ambiguous",
      recoveryPaths: expect.arrayContaining([oldPath, newPath]),
      batchProgress: {
        completedIds: ["char_002"],
        ambiguousIds: ["char_001"],
        remainingIds: ["char_003"],
      },
    });

    expect(disk.has(firstPath)).toBe(true);
    expect(disk.has(oldPath)).toBe(true);
    expect(disk.has(newPath)).toBe(true);
    expect(disk.has(pendingPath)).toBe(false);
  });

  test("旧ファイル退避後に新しい保存先が消えた場合は回復物を残して通知する", async () => {
    const original = fixedCharacter("char_001", "旧名");
    const renamed = { ...original, name: "新名" };
    const oldPath = diskPath(path.join(characterDir, characterFileName(original)));
    const newPath = diskPath(path.join(characterDir, characterFileName(renamed)));
    const originalBytes = bytesFor(original);
    disk.set(oldPath, originalBytes);
    const store = new CharacterStore(work);
    await store.loadAll();
    rename.mockImplementation(
      async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
        if (from.fsPath === oldPath && to.fsPath.endsWith(".bak")) {
          disk.delete(newPath);
        }
      }
    );

    await expect(store.save(renamed)).rejects.toMatchObject({
      kind: "path_conflict",
      message: expect.stringContaining("手動"),
    });

    const recoveryBytes = [...disk.entries()].find(
      ([filePath]) => filePath.endsWith(".bak")
    )?.[1];
    expect(recoveryBytes).toEqual(originalBytes);
    expect(disk.has(newPath)).toBe(false);
  });

  test("壊れた作者JSONを上書きしない", async () => {
    const malformedPath = diskPath(
      path.join(characterDir, "char_001_灯.json")
    );
    const malformedBytes = utf8('{"id":"char_001",');
    disk.set(malformedPath, malformedBytes);
    const store = new CharacterStore(work);
    const loaded = await store.loadAll();

    expect(loaded.errors).toEqual([
      expect.objectContaining({ file: "char_001_灯.json" }),
    ]);
    await expect(
      store.save(fixedCharacter("char_001", "灯"))
    ).rejects.toMatchObject({ kind: "path_conflict" });
    expect(disk.get(malformedPath)).toEqual(malformedBytes);
    expect(rename).not.toHaveBeenCalled();
  });

  test("人物ディレクトリが無い場合は空として扱い新規保存できる", async () => {
    directories.delete(characterDir);
    const store = new CharacterStore(work);

    await expect(store.loadAll()).resolves.toEqual({
      characters: [],
      errors: [],
    });
    const created = fixedCharacter("char_002", "灯");
    await store.save(created);

    expect(
      disk.has(diskPath(path.join(characterDir, characterFileName(created))))
    ).toBe(true);
  });

  test("人物ディレクトリと原子的置換の権限エラーを隠さない", async () => {
    workspace.fs.readDirectory = async () => {
      throw new FileSystemError("denied", "NoPermissions");
    };

    await expect(new CharacterStore(work).loadAll()).rejects.toThrow("denied");

    workspace.fs.readDirectory = async () => [];
    rename.mockRejectedValue(new FileSystemError("replace denied", "NoPermissions"));
    await expect(
      new CharacterStore(work).save(fixedCharacter("char_002", "灯"))
    ).rejects.toThrow("replace denied");
  });

  test("不正な人物データを保存しない", async () => {
    const invalid = { ...fixedCharacter("char_003", "灯"), aliases: "あかり" };

    await expect(new CharacterStore(work).save(invalid as never)).rejects.toThrow(
      "aliases"
    );
    expect(rename).not.toHaveBeenCalled();
  });

  /**
   * 既存の人物を書き換える経路。
   *
   * このプロジェクトは正規ファイルを上書きできないため、
   * 「回復先へ退避 → 新規作成」の順で行う（`atomicWrite.ts`）。
   * 手順を間違えると保存が必ず失敗する、要となる処理なのに
   * 単体テストが無く、実装後に一度も直接確かめられていなかった。
   */
  describe("既存人物の書き換え（退避→作り直し）", () => {
    test("退避してから作り直し、正規パスに新しい内容が残る", async () => {
      const original = fixedCharacter("char_001", "灯");
      const characterPath = diskPath(
        path.join(characterDir, characterFileName(original))
      );
      disk.set(characterPath, bytesFor(original));

      const store = new CharacterStore(work);
      await store.loadAll();
      await store.update({ ...original, personality: "冷静" });

      const saved = disk.get(characterPath);
      expect(saved).toBeDefined();
      expect(JSON.parse(new TextDecoder().decode(saved)).personality).toBe(
        "冷静"
      );
      // 退避した元の内容が回復先に残っている
      const recovered = [...disk.keys()].filter((p) =>
        p.includes(".novelai-recovery")
      );
      expect(recovered).toHaveLength(1);
      expect(
        JSON.parse(new TextDecoder().decode(disk.get(recovered[0])!)).personality
      ).toBe(original.personality);
    });

    test("名前を変えると、新しいファイル名で作り直す", async () => {
      const original = fixedCharacter("char_001", "灯");
      const oldPath = diskPath(
        path.join(characterDir, characterFileName(original))
      );
      disk.set(oldPath, bytesFor(original));

      const store = new CharacterStore(work);
      await store.loadAll();
      const renamed = { ...original, name: "月島灯" };
      await store.update(renamed);

      expect(disk.has(oldPath)).toBe(false);
      expect(
        disk.has(diskPath(path.join(characterDir, characterFileName(renamed))))
      ).toBe(true);
    });

    test("読み込み後に外部で変更されていたら、退避もしない", async () => {
      // 退避してしまうと、作者の変更が回復先へ隠れる
      const original = fixedCharacter("char_001", "灯");
      const characterPath = diskPath(
        path.join(characterDir, characterFileName(original))
      );
      disk.set(characterPath, bytesFor(original));

      const store = new CharacterStore(work);
      await store.loadAll();
      const editedByAuthor = bytesFor({
        ...original,
        authorNotes: "作者が追記",
      });
      disk.set(characterPath, editedByAuthor);

      await expect(
        store.update({ ...original, personality: "AIが更新" })
      ).rejects.toMatchObject({ kind: "modified_externally" });

      expect(disk.get(characterPath)).toEqual(editedByAuthor);
      expect(rename).not.toHaveBeenCalled();
    });

    test("未保存の変更があるときは、退避せずに止める", async () => {
      const original = fixedCharacter("char_001", "灯");
      const characterPath = diskPath(
        path.join(characterDir, characterFileName(original))
      );
      disk.set(characterPath, bytesFor(original));

      const store = new CharacterStore(work);
      await store.loadAll();
      workspace.textDocuments = [
        { uri: Uri.file(characterPath), isDirty: true },
      ];

      await expect(store.retire("char_001")).rejects.toMatchObject({
        kind: "unsaved_changes",
      });
      expect(disk.get(characterPath)).toBeDefined();
      expect(rename).not.toHaveBeenCalled();
    });

    test("読み込んでいない人物は退避できない", async () => {
      const store = new CharacterStore(work);
      await store.loadAll();

      await expect(store.retire("char_999")).rejects.toMatchObject({
        kind: "path_conflict",
      });
    });

    test("退避できたのに作り直せない場合は、回復先を知らせる", async () => {
      // 正規パスにファイルが無い状態になる。どこにあるかを必ず伝える
      const original = fixedCharacter("char_001", "灯");
      const characterPath = diskPath(
        path.join(characterDir, characterFileName(original))
      );
      disk.set(characterPath, bytesFor(original));

      const store = new CharacterStore(work);
      await store.loadAll();

      // 退避のrenameだけ通し、作り直しのrenameを失敗させる
      let calls = 0;
      rename.mockImplementation(
        async (from: { fsPath: string }, to: { fsPath: string }) => {
          calls++;
          if (calls === 1) {
            const bytes = disk.get(from.fsPath);
            if (!bytes) throw new FileSystemError("missing", "FileNotFound");
            disk.set(to.fsPath, bytes);
            disk.delete(from.fsPath);
            return;
          }
          throw new FileSystemError("書き込めません", "NoPermissions");
        }
      );

      const failure = await store
        .update({ ...original, personality: "冷静" })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CharacterStoreError);
      const error = failure as CharacterStoreError;
      expect(error.persistenceState).toBe("ambiguous");
      expect(
        error.recoveryPaths.some((p) => p.includes(".novelai-recovery"))
      ).toBe(true);
      expect(error.message).toContain("手動で戻してください");
    });
  });

  describe("saveOrUpdate の呼び分け", () => {
    test("読み込んでいない人物は新規作成になる", async () => {
      const store = new CharacterStore(work);
      await store.loadAll();

      const created = fixedCharacter("char_001", "灯");
      await store.saveOrUpdate(created);

      expect(
        disk.has(diskPath(path.join(characterDir, characterFileName(created))))
      ).toBe(true);
      // 新規なので退避は起きない
      expect(
        [...disk.keys()].filter((p) => p.includes(".novelai-recovery"))
      ).toHaveLength(0);
    });

    test("読み込み済みの人物は書き換えになる", async () => {
      const original = fixedCharacter("char_001", "灯");
      disk.set(
        diskPath(path.join(characterDir, characterFileName(original))),
        bytesFor(original)
      );

      const store = new CharacterStore(work);
      await store.loadAll();
      await store.saveOrUpdate({ ...original, personality: "冷静" });

      // 書き換えなので退避が起きる
      expect(
        [...disk.keys()].filter((p) => p.includes(".novelai-recovery"))
      ).toHaveLength(1);
    });
  });
});

describe("人物ファイル検証", () => {
  test("不正な配列と入れ子構造を拒否する", () => {
    const valid = emptyCharacter("char_001", "灯");
    const invalidValues: Array<[string, unknown]> = [
      ["aliases", "あかり"],
      ["physical", { age: 17, height: null }],
      ["firstPerson", { default: null, variants: "私" }],
      ["addressTerms", [{ targetName: "澪", forms: "澪さん", authorLocked: false }]],
      ["relations", [{ name: "澪", relation: 1 }]],
      ["appearedChapters", [1, "2"]],
      ["isMob", "true"],
      ["conflicts", [{ field: "age", values: "17", chapters: [1], note: null }]],
    ];

    for (const [field, value] of invalidValues) {
      expect(() => parseCharacter({ ...valid, [field]: value }), field).toThrow(field);
    }
  });

  test("欠損した任意項目は安全な既定値で補う", () => {
    const parsed = parseCharacter({ id: "char_001", name: "灯" });

    expect(parsed.aliases).toEqual([]);
    expect(parsed.physical).toBeNull();
    expect(parsed.firstPerson).toEqual({ default: null, variants: [] });
    expect(parsed.authorNotes).toBe("");
  });

  test("食い違いの値ごとの話数を読み込みで落とさない", () => {
    const parsed = parseCharacter({
      id: "char_001",
      name: "灯",
      conflicts: [
        {
          field: "appearance",
          values: ["黒髪", "銀髪"],
          observations: [
            { value: "黒髪", chapters: [1] },
            { value: "銀髪", chapters: [7] },
          ],
        },
      ],
    });

    expect(parsed.conflicts[0].observations).toEqual([
      { value: "黒髪", chapters: [1] },
      { value: "銀髪", chapters: [7] },
    ]);
  });

  test("ファイル名へ使えない人物IDを拒否する", () => {
    expect(() => parseCharacter({ id: "../outside", name: "灯" })).toThrow("id");
  });

  test("ファイル名と人物IDの不一致を読み込みエラーにする", async () => {
    const encoded = bytesFor(fixedCharacter("char_001", "灯"));
    workspace.fs = {
      readDirectory: async () => [
        ["char_999_灯.json", FileType.File],
      ] as Array<[string, FileType]>,
      readFile: async (uri: { fsPath: string }) => {
        if (uri.fsPath.endsWith("config.json")) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return encoded;
      },
    };

    const loaded = await new CharacterStore(work).loadAll();

    expect(loaded.characters).toEqual([]);
    expect(loaded.errors).toEqual([
      expect.objectContaining({
        file: "char_999_灯.json",
        message: expect.stringContaining("一致しません"),
      }),
    ]);
  });

  test("同じIDの人物ファイルを二重に読み込まない", async () => {
    const encoded = bytesFor(fixedCharacter("char_001", "灯"));
    workspace.fs = {
      readDirectory: async () => [
        ["char_001_灯.json", FileType.File],
        ["char_001_旧名.json", FileType.File],
      ] as Array<[string, FileType]>,
      readFile: async (uri: { fsPath: string }) => {
        if (uri.fsPath.endsWith("config.json")) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return encoded;
      },
    };

    const loaded = await new CharacterStore(work).loadAll();

    expect(loaded.characters).toHaveLength(1);
    expect(loaded.errors).toEqual([
      expect.objectContaining({ file: "char_001_旧名.json", message: expect.stringContaining("重複") }),
    ]);
  });
});
