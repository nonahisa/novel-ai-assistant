import { beforeEach, describe, expect, test, vi } from "vitest";
import { atomicWriteFile } from "../../src/core/atomicWrite";
import { workspace } from "./support/vscodeStub";

const path = "C:\\novels\\001.txt";

describe("原稿の原子的な保存", () => {
  const files = new Map<string, Uint8Array>();
  const deletedPaths: string[] = [];

  beforeEach(() => {
    files.clear();
    deletedPaths.length = 0;
    workspace.fs = {
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(uri.fsPath, bytes);
      }),
      rename: vi.fn(async (from: { fsPath: string }, to: { fsPath: string }) => {
        const bytes = files.get(from.fsPath);
        if (!bytes) throw new Error("一時ファイルがありません");
        files.set(to.fsPath, bytes);
        files.delete(from.fsPath);
      }),
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
    expect(temporary.fsPath).toMatch(/^C:\\novels\\001\.txt\.novelai-\d+-.+\.tmp$/);
    expect(destination.fsPath).toBe(path);
    expect(options).toEqual({ overwrite: true });
    expect(files.get(path)).toEqual(bytes);
  });

  test("置換に失敗したときは生成した一時ファイルだけを削除する", async () => {
    const original = new Uint8Array([0x8b, 0x8c]);
    files.set(path, original);
    workspace.fs.rename = vi.fn(async () => {
      throw new Error("置換できません");
    });

    await expect(atomicWriteFile(path, new Uint8Array([0x93, 0x94]))).rejects.toThrow(
      "置換できません"
    );

    expect(deletedPaths).toHaveLength(1);
    expect(deletedPaths[0]).not.toBe(path);
    expect(deletedPaths[0]).toMatch(/^C:\\novels\\001\.txt\.novelai-\d+-.+\.tmp$/);
    expect(files.get(path)).toEqual(original);
  });
});
