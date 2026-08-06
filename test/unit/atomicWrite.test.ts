import * as crypto from "crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { atomicWriteFile } from "../../src/core/atomicWrite";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

const path = "C:\\novels\\001.txt";
const destinationPath = Uri.file(path).fsPath;

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

describe("原稿の原子的な保存", () => {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const deletedPaths: string[] = [];

  beforeEach(() => {
    files.clear();
    directories.clear();
    directories.add("c:\\novels");
    deletedPaths.length = 0;
    workspace.fs = {
      createDirectory: vi.fn(async (uri: { fsPath: string }) => {
        directories.add(uri.fsPath);
      }),
      readDirectory: vi.fn(async (uri: { fsPath: string }) => {
        if (!directories.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return [...files.keys()]
          .filter((filePath) => filePath.slice(0, filePath.lastIndexOf("\\")) === uri.fsPath)
          .map((filePath) => [filePath.slice(filePath.lastIndexOf("\\") + 1), 1]);
      }),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(uri.fsPath, bytes);
      }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const bytes = files.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      }),
      rename: vi.fn(
        async (
          from: { fsPath: string },
          to: { fsPath: string },
          options?: { overwrite?: boolean }
        ) => {
          const bytes = files.get(from.fsPath);
          if (!bytes) throw new Error("一時ファイルがありません");
          if (!options?.overwrite && files.has(to.fsPath)) {
            throw new FileSystemError("exists", "FileExists");
          }
          files.set(to.fsPath, bytes);
          files.delete(from.fsPath);
        }
      ),
      delete: vi.fn(async (uri: { fsPath: string }) => {
        deletedPaths.push(uri.fsPath);
        files.delete(uri.fsPath);
      }),
    };
  });

  test("同じディレクトリの一時ファイルから置換する", async () => {
    const bytes = new Uint8Array([0x93, 0x94]);

    await atomicWriteFile(path, bytes);

    const rename = workspace.fs.rename as ReturnType<typeof vi.fn>;
    const [temporary, destination, options] = rename.mock.calls[0] as [
      { fsPath: string },
      { fsPath: string },
      { overwrite: boolean },
    ];
    expect(temporary.fsPath).toMatch(/^c:\\novels\\001\.txt\.novelai-\d+-.+\.tmp$/);
    expect(destination.fsPath).toBe(destinationPath);
    expect(options).toEqual({ overwrite: true });
    expect(files.get(destinationPath)).toEqual(bytes);
  });

  test("置換に失敗したときは生成した一時ファイルだけを削除する", async () => {
    const original = new Uint8Array([0x8b, 0x8c]);
    files.set(destinationPath, original);
    workspace.fs.rename = vi.fn(async () => {
      throw new Error("置換できません");
    });

    await expect(atomicWriteFile(path, new Uint8Array([0x93, 0x94]))).rejects.toThrow(
      "置換できません"
    );

    expect(deletedPaths).toHaveLength(1);
    expect(deletedPaths[0]).not.toBe(destinationPath);
    expect(deletedPaths[0]).toMatch(/^c:\\novels\\001\.txt\.novelai-\d+-.+\.tmp$/);
    expect(files.get(destinationPath)).toEqual(original);
  });

  test("一時ファイル書き込み中の同一パス外部編集を上書きしない", async () => {
    const original = new Uint8Array([0x01, 0x02]);
    const changedByAuthor = new Uint8Array([0x03, 0x04]);
    const replacement = new Uint8Array([0x05, 0x06]);
    files.set(destinationPath, original);
    workspace.fs.writeFile = vi.fn(
      async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(uri.fsPath, bytes);
        files.set(destinationPath, changedByAuthor);
      }
    );

    await expect(
      atomicWriteFile(path, replacement, {
        mode: "replace",
        expectedHash: sha256(original),
      })
    ).rejects.toMatchObject({ kind: "modified_externally" });

    expect(files.get(destinationPath)).toEqual(changedByAuthor);
  });

  test("一時ファイル書き込み中に作られた保存先を上書きしない", async () => {
    const createdByAuthor = new Uint8Array([0x07, 0x08]);
    workspace.fs.writeFile = vi.fn(
      async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(uri.fsPath, bytes);
        files.set(destinationPath, createdByAuthor);
      }
    );

    await expect(
      atomicWriteFile(path, new Uint8Array([0x09, 0x0a]), { mode: "create" })
    ).rejects.toMatchObject({
      kind: "path_conflict",
      persistenceState: "not_saved",
    });

    expect(files.get(destinationPath)).toEqual(createdByAuthor);
  });

  test("配置後の確認中に新ファイルが消えても元内容の回復ファイルを残す", async () => {
    const original = new Uint8Array([0x11, 0x12]);
    const replacement = new Uint8Array([0x13, 0x14]);
    files.set(destinationPath, original);
    let backupReads = 0;
    workspace.fs.readFile = vi.fn(async (uri: { fsPath: string }) => {
      const bytes = files.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (uri.fsPath.endsWith(".bak")) {
        backupReads += 1;
        if (backupReads === 2) files.delete(destinationPath);
      }
      return bytes;
    });

    await expect(
      atomicWriteFile(path, replacement, {
        mode: "replace",
        expectedHash: sha256(original),
      })
    ).rejects.toMatchObject({
      kind: "path_conflict",
      persistenceState: "ambiguous",
      message: expect.stringContaining("手動"),
    });

    const recoveryBytes = [...files.entries()].find(([filePath]) =>
      filePath.endsWith(".bak")
    )?.[1];
    expect(recoveryBytes).toEqual(original);
  });

  test("旧内容の退避後に読込権限を失っても型付きエラーと回復ファイルを残す", async () => {
    const original = new Uint8Array([0x21, 0x22]);
    files.set(destinationPath, original);
    workspace.fs.readFile = vi.fn(async (uri: { fsPath: string }) => {
      if (uri.fsPath.endsWith(".bak")) {
        throw new FileSystemError("backup denied", "NoPermissions");
      }
      const bytes = files.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    });

    await expect(
      atomicWriteFile(path, new Uint8Array([0x23, 0x24]), {
        mode: "replace",
        expectedHash: sha256(original),
      })
    ).rejects.toMatchObject({
      kind: "path_conflict",
      message: expect.stringContaining("手動"),
    });

    const recoveryBytes = [...files.entries()].find(([filePath]) =>
      filePath.endsWith(".bak")
    )?.[1];
    expect(recoveryBytes).toEqual(original);
  });

  test("一時ファイル回収時の権限エラーで元の競合を隠さない", async () => {
    const createdByAuthor = new Uint8Array([0x31, 0x32]);
    files.set(destinationPath, createdByAuthor);
    let denyCleanup = false;
    workspace.fs.readFile = vi.fn(async (uri: { fsPath: string }) => {
      if (denyCleanup) {
        throw new FileSystemError("directory denied", "NoPermissions");
      }
      const bytes = files.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (uri.fsPath === destinationPath) denyCleanup = true;
      return bytes;
    });

    await expect(
      atomicWriteFile(path, new Uint8Array([0x33, 0x34]), { mode: "create" })
    ).rejects.toMatchObject({ kind: "path_conflict" });

    expect(files.get(destinationPath)).toEqual(createdByAuthor);
    expect(
      [...files.keys()].some((filePath) => filePath.endsWith(".tmp"))
    ).toBe(true);
  });

  test("6回の置換後は管理回復ディレクトリに最新5世代だけ残す", async () => {
    const recoveryDir = "c:\\novels\\.novelai-recovery";
    const unmanagedPath = `${recoveryDir}\\作者保管.bak`;
    directories.add(recoveryDir);
    files.set(unmanagedPath, new Uint8Array([0x41]));
    let current = new Uint8Array([0x42]);
    files.set(destinationPath, current);

    for (let generation = 1; generation <= 6; generation += 1) {
      const next = new Uint8Array([0x42 + generation]);
      await atomicWriteFile(path, next, {
        mode: "replace",
        expectedHash: sha256(current),
      });
      current = next;
    }

    const managed = [...files.entries()].filter(
      ([filePath]) =>
        filePath.startsWith(`${recoveryDir}\\`) && filePath !== unmanagedPath
    );
    expect(managed).toHaveLength(5);
    expect(new Set(managed.map(([filePath]) => filePath.split("\\").at(-1)?.split("-")[0])).size)
      .toBe(1);
    expect(files.get(unmanagedPath)).toEqual(new Uint8Array([0x41]));
    expect(files.get(destinationPath)).toEqual(current);
    expect(
      [...files.keys()].some(
        (filePath) => filePath.startsWith(`${destinationPath}.novelai-`) && filePath.endsWith(".bak")
      )
    ).toBe(false);
  });
});
