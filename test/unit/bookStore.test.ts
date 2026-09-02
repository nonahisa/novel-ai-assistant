import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { BookStore, BookStoreError } from "../../src/core/bookStore";
import { defaultBookConfig } from "../../src/models/book";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

/**
 * 本の設計図の保存（設計書6.65.6）。
 *
 * `book.json` は**作者が手で開いて直すJSON**であり、別の端末から同期でも
 * 降ってくる。エディター画面を開いたまま外で直されたら、**上書きせずに
 * 止める**——これは人物・設定資料の台帳と同じ約束である。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-09-03T00:00:00.000Z",
};

const bookPath = diskPath(
  path.join(work.folderPath, "設定", "書籍", "book.json")
);

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("本の設計図の読み書き", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename: async (
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
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;
  });

  function written(): Record<string, unknown> {
    const bytes = disk.get(bookPath);
    if (!bytes) throw new Error("book.json が書かれていません");
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  }

  test("まだ無ければ既定値で読める（第1段の本と同じ体裁）", async () => {
    const store = new BookStore(work);
    expect(await store.load()).toEqual(defaultBookConfig("氷の街"));
  });

  test("自分で保存したものは、続けて保存できる", async () => {
    const store = new BookStore(work);
    const config = await store.load();

    await store.save({ ...config, author: "野中" });
    expect(written().author).toBe("野中");

    // 保存で覚え直しているので、2度目も通る
    await store.save({ ...config, author: "野中", label: "○○文庫" });
    expect(written().label).toBe("○○文庫");
  });

  test("読み込んだあとに外で変わっていたら、上書きせずに止める", async () => {
    disk.set(bookPath, utf8(JSON.stringify({ title: "氷の街" })));
    const store = new BookStore(work);
    const config = await store.load();

    const outside = utf8(
      JSON.stringify({ title: "氷の街", author: "作者が手で書いた" })
    );
    disk.set(bookPath, outside);

    await expect(store.save({ ...config, author: "画面から" })).rejects.toMatchObject(
      { kind: "modified_externally" }
    );
    // 作者が書いたものが残っている
    expect(disk.get(bookPath)).toEqual(outside);
  });

  test("読み込みのときに無かったファイルが、外で作られていたら止める", async () => {
    const store = new BookStore(work);
    const config = await store.load();

    const outside = utf8(JSON.stringify({ title: "別の端末から" }));
    disk.set(bookPath, outside);

    await expect(store.save(config)).rejects.toMatchObject({
      kind: "modified_externally",
    });
    expect(disk.get(bookPath)).toEqual(outside);
  });

  test("読み込んだあとに外で消されていたら止める", async () => {
    disk.set(bookPath, utf8(JSON.stringify({ title: "氷の街" })));
    const store = new BookStore(work);
    const config = await store.load();
    disk.delete(bookPath);

    await expect(store.save(config)).rejects.toMatchObject({
      kind: "modified_externally",
    });
    expect(disk.has(bookPath)).toBe(false);
  });

  test("壊れたJSONは修復しない（読めないと言って止まる）", async () => {
    disk.set(bookPath, utf8("{ title: 壊れている"));
    const store = new BookStore(work);

    await expect(store.load()).rejects.toMatchObject({ kind: "invalid_json" });
    // 読めていないので、保存もさせない（作者の書いたものを消さない）
    await expect(store.save(defaultBookConfig("氷の街"))).rejects.toBeInstanceOf(
      BookStoreError
    );
    expect(new TextDecoder().decode(disk.get(bookPath))).toBe(
      "{ title: 壊れている"
    );
  });

  test("形は合っていても値が不正なら止める", async () => {
    disk.set(bookPath, utf8(JSON.stringify({ writingMode: "たて" })));
    const store = new BookStore(work);

    await expect(store.load()).rejects.toMatchObject({ kind: "invalid_json" });
  });

  test("読み込む前には保存しない", async () => {
    const store = new BookStore(work);
    await expect(store.save(defaultBookConfig("氷の街"))).rejects.toBeInstanceOf(
      BookStoreError
    );
    expect(disk.has(bookPath)).toBe(false);
  });

  test("保存したJSONは、そのまま読み直せる", async () => {
    const store = new BookStore(work);
    const config = await store.load();
    await store.save({ ...config, tocPattern: "chapters", tocOrnament: "rule" });

    const reopened = await new BookStore(work).load();
    expect(reopened.tocPattern).toBe("chapters");
    expect(reopened.tocOrnament).toBe("rule");
  });
});
