import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CharacterStore } from "../../src/core/characterStore";
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
    ).rejects.toMatchObject({ kind: "modified_externally" });

    expect(rename).not.toHaveBeenCalled();
    expect(disk.get(characterPath)).toEqual(changedByAuthorBytes);
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
    ).rejects.toMatchObject({ kind: "modified_externally" });

    expect(rename).not.toHaveBeenCalled();
    expect(disk.get(firstPath)).toEqual(firstBytes);
  });

  test("未変更の人物は原子的に保存し作者メモと資料注記を保つ", async () => {
    const original = {
      ...fixedCharacter("char_001", "灯"),
      authorNotes: "作者メモ",
      exportNote: "公開用注記",
    };
    const characterPath = diskPath(path.join(characterDir, characterFileName(original)));
    disk.set(characterPath, bytesFor(original));
    const store = new CharacterStore(work);
    const loaded = await store.loadAll();

    await store.save(loaded.characters[0]);

    const saved = JSON.parse(
      new TextDecoder().decode(disk.get(characterPath))
    ) as Record<string, unknown>;
    expect(saved).toMatchObject({
      authorNotes: "作者メモ",
      exportNote: "公開用注記",
    });
    expect(rename).toHaveBeenCalledOnce();
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

  test("旧ファイルの削除失敗時は新しい保存先を取り消す", async () => {
    const original = fixedCharacter("char_001", "旧名");
    const renamed = { ...original, name: "新名" };
    const oldPath = diskPath(path.join(characterDir, characterFileName(original)));
    const newPath = diskPath(path.join(characterDir, characterFileName(renamed)));
    const originalBytes = bytesFor(original);
    disk.set(oldPath, originalBytes);
    const store = new CharacterStore(work);
    await store.loadAll();
    remove.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === oldPath) {
        throw new FileSystemError("denied", "NoPermissions");
      }
      disk.delete(uri.fsPath);
    });

    await expect(store.save(renamed)).rejects.toThrow("denied");

    expect(disk.get(oldPath)).toEqual(originalBytes);
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
