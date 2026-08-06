import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChunkCache, type CacheKeyBase } from "../../src/core/chunkCache";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-08-07T00:00:00.000Z",
};

const base: CacheKeyBase = {
  feature: "characters",
  promptVersion: "1.0",
  model: "gemma4:e4b",
};

const cachePath = diskPath(
  path.join(work.folderPath, ".aiwriter", "cache", "chunks.json")
);

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("チャンク処理キャッシュ", () => {
  const disk = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  let rename: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disk.clear();
    directories.clear();
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

    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        directories.add(uri.fsPath);
      },
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      }),
      rename,
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
    };
  });

  test.each(["{", "{}", "null"])(
    "不正キャッシュ %s を空として扱う",
    async (json) => {
      disk.set(cachePath, utf8(json));
      const cache = new ChunkCache(work);

      await cache.load();

      expect(cache.size).toBe(0);
    }
  );

  test("再読み込み前に古いメモリ内容を消し有効項目だけ採用する", async () => {
    const validValue = { characters: ["灯"] };
    const source = new ChunkCache(work);
    await source.set("valid", base, validValue);
    await source.save();
    const validEntry = JSON.parse(
      new TextDecoder().decode(disk.get(cachePath))
    ) as Array<{ key: string; createdAt: string; value: unknown }>;
    disk.set(
      cachePath,
      utf8(
        JSON.stringify([
          validEntry[0],
          { key: 5, createdAt: "not-a-date", value: "invalid" },
        ])
      )
    );
    const cache = new ChunkCache(work);
    await cache.set("old", base, { stale: true });

    await cache.load();

    expect(cache.size).toBe(1);
    expect(cache.get("valid", base)).toEqual(validValue);
    expect(cache.get("old", base)).toBeUndefined();
  });

  test("不正な作成日時の項目を採用しない", async () => {
    disk.set(
      cachePath,
      utf8(
        JSON.stringify([
          { key: "valid", createdAt: "2026-08-07T00:00:00.000Z", value: 1 },
          { key: "invalid", createdAt: "2026-02-30T00:00:00.000Z", value: 2 },
        ])
      )
    );
    const cache = new ChunkCache(work);

    await cache.load();

    expect(cache.size).toBe(1);
  });

  test("値を持たない項目を採用しない", async () => {
    disk.set(
      cachePath,
      utf8(
        JSON.stringify([
          { key: "valid", createdAt: "2026-08-07T00:00:00.000Z", value: null },
          { key: "missing", createdAt: "2026-08-07T00:00:00.000Z" },
        ])
      )
    );
    const cache = new ChunkCache(work);

    await cache.load();

    expect(cache.size).toBe(1);
  });

  test("モデルとプロンプトの異なる結果を再利用しない", async () => {
    const cache = new ChunkCache(work);
    await cache.set("same-content", base, { model: base.model });

    expect(cache.get("same-content", { ...base, model: "other-model" })).toBeUndefined();
    expect(cache.get("same-content", { ...base, promptVersion: "1.1" })).toBeUndefined();
    expect(cache.get("same-content", base)).toEqual({ model: base.model });
  });

  test("指定機能の項目だけを破棄する", async () => {
    const cache = new ChunkCache(work);
    const other: CacheKeyBase = { ...base, feature: "locations" };
    await cache.set("characters", base, { value: "characters" });
    await cache.set("locations", other, { value: "locations" });

    cache.clearFeature("characters");

    expect(cache.get("characters", base)).toBeUndefined();
    expect(cache.get("locations", other)).toEqual({ value: "locations" });
  });

  test("未変更のキャッシュは保存しない", async () => {
    const cache = new ChunkCache(work);
    const writeFile = workspace.fs.writeFile as ReturnType<typeof vi.fn>;

    await cache.save();

    expect(writeFile).not.toHaveBeenCalled();
  });

  test("原子的な保存が失敗しても次回保存のため変更状態を保つ", async () => {
    const cache = new ChunkCache(work);
    await cache.set("retry", base, { retry: true });
    rename.mockRejectedValueOnce(new Error("replace failed"));

    await expect(cache.save()).rejects.toThrow("replace failed");

    await cache.save();
    expect(JSON.parse(new TextDecoder().decode(disk.get(cachePath)))).toHaveLength(1);
  });
});
