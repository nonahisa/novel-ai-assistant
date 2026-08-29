import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";

// 掃除の件数はログにだけ出る（通知には出さない）ので、記録の中身を見るために差し替える
vi.mock("../../src/core/logger", () => ({ logLine: vi.fn() }));

import {
  ChunkCache,
  CHUNK_CACHE_MAX_ENTRIES,
  type CacheKeyBase,
} from "../../src/core/chunkCache";
import { logLine } from "../../src/core/logger";
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
  providerId: "ollama",
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

  /** 書き出されたJSONを読む。`lastUsedAt` はファイルにどう残るかが要点なので生で見る */
  function entriesOnDisk(): Array<{
    key: string;
    createdAt: string;
    lastUsedAt?: string;
    value: unknown;
  }> {
    const bytes = disk.get(cachePath);
    if (!bytes) throw new Error("キャッシュファイルが書かれていない");
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  beforeEach(() => {
    disk.clear();
    directories.clear();
    vi.mocked(logLine).mockClear();
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

  test("タイムゾーン付きISO 8601日時だけを採用する", async () => {
    const validDates = [
      "2026-08-07T00:00:00Z",
      "2026-08-07T09:00:00.12+09:00",
      "2024-02-29T00:00:00Z",
    ];
    const invalidDates = [
      "2026-08-07T00:00:00",
      "2026-13-01T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-06-31T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "2024-02-30T00:00:00Z",
      "2026-08-07T24:00:00Z",
      "2026-08-07T23:60:00Z",
      "2026-08-07T23:00:60Z",
      "2026-08-07T23:00:00+24:00",
      "2026-08-07T23:00:00+09:60",
      "August 7, 2026 00:00:00Z",
    ];
    disk.set(
      cachePath,
      utf8(
        JSON.stringify([
          ...validDates.map((createdAt, index) => ({
            key: `valid-${index}`,
            createdAt,
            value: createdAt,
          })),
          ...invalidDates.map((createdAt, index) => ({
            key: `invalid-${index}`,
            createdAt,
            value: createdAt,
          })),
        ])
      )
    );
    const cache = new ChunkCache(work);

    await cache.load();

    expect(cache.size).toBe(validDates.length);
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

  /**
   * **同じ名前のモデルが、別のサービスに在る**（設計書6.28.7）。
   *
   * Ollama と LM Studio は同じ重みを同じ名前（`gemma4:e4b` など）で
   * 持てるので、鍵がモデル名だけだと**別のプロバイダで作った結果を
   * 再利用してしまう**。地力も設定も違うので、答えは揃わない。
   */
  test("同じモデル名でも、プロバイダが違えば結果を再利用しない", async () => {
    const cache = new ChunkCache(work);
    await cache.set("same-content", base, { from: "ollama" });

    expect(
      cache.get("same-content", { ...base, providerId: "lmstudio" })
    ).toBeUndefined();
    expect(cache.get("same-content", base)).toEqual({ from: "ollama" });
  });

  /**
   * `.aiwriter/cache/` はGit同期の対象にできる（設計書5.5.7）。
   * 当たるたびに日付を書き換えると、読むだけの操作でも差分が出続ける。
   */
  test("1日未満に当たった鍵は、最後に使った日を書き換えず保存もしない", async () => {
    let current = new Date("2026-08-01T00:00:00.000Z");
    const cache = new ChunkCache(work, { now: () => current });
    await cache.set("hit", base, { v: 1 });
    await cache.save();
    const writeFile = workspace.fs.writeFile as ReturnType<typeof vi.fn>;
    writeFile.mockClear();

    current = new Date("2026-08-01T20:00:00.000Z");
    expect(cache.get("hit", base)).toEqual({ v: 1 });
    await cache.save();

    expect(writeFile).not.toHaveBeenCalled();
    expect(entriesOnDisk()[0].lastUsedAt).toBeUndefined();
  });

  test("1日以上ぶりに当たった鍵は、最後に使った日を今にして保存する", async () => {
    let current = new Date("2026-08-01T00:00:00.000Z");
    const cache = new ChunkCache(work, { now: () => current });
    await cache.set("hit", base, { v: 1 });
    await cache.save();
    const writeFile = workspace.fs.writeFile as ReturnType<typeof vi.fn>;
    writeFile.mockClear();

    current = new Date("2026-08-03T00:00:00.000Z");
    expect(cache.get("hit", base)).toEqual({ v: 1 });
    await cache.save();

    expect(writeFile).toHaveBeenCalled();
    expect(entriesOnDisk()[0].lastUsedAt).toBe("2026-08-03T00:00:00.000Z");
  });

  /** 掃除を入れる前に書かれたファイルには `lastUsedAt` が無い */
  test("最後に使った日が無い古い形式は、作った日で判定して読み込める", async () => {
    const source = new ChunkCache(work, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await source.set("old-format", base, { v: "古い" });
    await source.save();
    expect(entriesOnDisk()[0].lastUsedAt).toBeUndefined();

    // 作った日から179日後。まだ期限内なので、読めるし掃除でも消えない
    const cache = new ChunkCache(work, {
      now: () => new Date("2026-06-29T00:00:00.000Z"),
    });
    await cache.load();

    expect(cache.size).toBe(1);
    expect(cache.get("old-format", base)).toEqual({ v: "古い" });
  });

  test("180日使われていない鍵は保存時に消え、当たった鍵は同じ保存でも残る", async () => {
    const source = new ChunkCache(work, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await source.set("stale", base, { v: "使われていない" });
    await source.set("fresh", base, { v: "現役" });
    await source.save();

    // 作った日から185日後。何もしなければ両方とも期限切れになる日付
    const cache = new ChunkCache(work, {
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });
    await cache.load();
    expect(cache.get("fresh", base)).toEqual({ v: "現役" });

    await cache.save();

    expect(cache.size).toBe(1);
    expect(cache.get("stale", base)).toBeUndefined();
    expect(entriesOnDisk().map((entry) => entry.value)).toEqual([
      { v: "現役" },
    ]);
    expect(vi.mocked(logLine)).toHaveBeenCalledWith(
      "チャンクキャッシュ：使われていない 1 件を捨てました（残り 1 件）"
    );
  });

  test("上限を超えたら、1日以上前に使われたものを古い順に目安まで捨てる", async () => {
    const origin = Date.parse("2026-08-01T00:00:00.000Z");
    let current = new Date(origin);
    const cache = new ChunkCache(work, { now: () => current });
    for (let index = 0; index <= CHUNK_CACHE_MAX_ENTRIES; index += 1) {
      // 1件ずつ作った時刻をずらし、「いちばん古い」が一意に決まるようにする
      current = new Date(origin + index * 1000);
      await cache.set(`chunk-${index}`, base, { index });
    }
    expect(cache.size).toBe(CHUNK_CACHE_MAX_ENTRIES + 1);

    // 3日後。作り置きはすべて「1日以上前」になったので、捨てる候補に入る
    current = new Date("2026-08-04T00:00:00.000Z");
    // 最も古い鍵に当てる。当たった鍵は日付が今になるので、捨てる対象から外れる
    expect(cache.get("chunk-0", base)).toEqual({ index: 0 });

    await cache.save();

    expect(cache.size).toBe(CHUNK_CACHE_MAX_ENTRIES);
    expect(cache.get("chunk-0", base)).toEqual({ index: 0 });
    // 当たらなかったもののうち、いちばん古い1件だけが落ちる
    expect(cache.get("chunk-1", base)).toBeUndefined();
    expect(cache.get("chunk-2", base)).toEqual({ index: 2 });
  });

  /**
   * **上限が柔らかいことの要点。**
   *
   * 硬い上限だと、1回の走査で作った項目のうち先に作ったぶんが押し出され、
   * 次の実行で作り直してまた押し出される——という往復になる。
   */
  test("同じ日に作った項目どうしは、上限を超えても押し合わない", async () => {
    const origin = Date.parse("2026-08-01T00:00:00.000Z");
    let current = new Date(origin);
    const cache = new ChunkCache(work, { now: () => current });
    for (let index = 0; index <= CHUNK_CACHE_MAX_ENTRIES; index += 1) {
      current = new Date(origin + index * 1000);
      await cache.set(`chunk-${index}`, base, { index });
    }

    await cache.save();

    expect(cache.size).toBe(CHUNK_CACHE_MAX_ENTRIES + 1);
    expect(cache.get("chunk-0", base)).toEqual({ index: 0 });
    expect(vi.mocked(logLine)).not.toHaveBeenCalled();
  });

  test("上限を超えていても、捨てるのは1日以上前の項目だけで今日の項目は残す", async () => {
    const origin = Date.parse("2026-08-01T00:00:00.000Z");
    let current = new Date(origin);
    const cache = new ChunkCache(work, { now: () => current });
    for (let index = 0; index < 10; index += 1) {
      current = new Date(origin + index * 1000);
      await cache.set(`old-${index}`, base, { index });
    }
    // 3日後にまとめて作る。この3,995件は「今日」なので捨てる候補に入らない
    const today = Date.parse("2026-08-04T00:00:00.000Z");
    for (let index = 0; index < 3995; index += 1) {
      current = new Date(today + index * 1000);
      await cache.set(`today-${index}`, base, { index });
    }
    expect(cache.size).toBe(4005);

    await cache.save();

    // 超過は5件。候補は古い10件しかないので、そこから古い順に5件だけ落ちる
    expect(cache.size).toBe(CHUNK_CACHE_MAX_ENTRIES);
    expect(cache.get("old-0", base)).toBeUndefined();
    expect(cache.get("old-4", base)).toBeUndefined();
    expect(cache.get("old-5", base)).toEqual({ index: 5 });
    // 今日の項目は1件も減らない
    expect(cache.get("today-0", base)).toEqual({ index: 0 });
    expect(cache.get("today-3994", base)).toEqual({ index: 3994 });
    expect(vi.mocked(logLine)).toHaveBeenCalledWith(
      "チャンクキャッシュ：使われていない 5 件を捨てました（残り 4000 件）"
    );
  });

  test("古い項目を出し切っても足りなければ、上限を超えたまま残す", async () => {
    const origin = Date.parse("2026-08-01T00:00:00.000Z");
    let current = new Date(origin);
    const cache = new ChunkCache(work, { now: () => current });
    for (let index = 0; index < 10; index += 1) {
      current = new Date(origin + index * 1000);
      await cache.set(`old-${index}`, base, { index });
    }
    // 今日だけで上限を超える。超過11件に対し、捨てられるのは古い10件しかない
    const today = Date.parse("2026-08-04T00:00:00.000Z");
    for (let index = 0; index <= CHUNK_CACHE_MAX_ENTRIES; index += 1) {
      current = new Date(today + index * 1000);
      await cache.set(`today-${index}`, base, { index });
    }

    await cache.save();

    expect(cache.size).toBe(CHUNK_CACHE_MAX_ENTRIES + 1);
    expect(cache.get("old-9", base)).toBeUndefined();
    expect(cache.get("today-0", base)).toEqual({ index: 0 });
    expect(vi.mocked(logLine)).toHaveBeenCalledWith(
      "チャンクキャッシュ：使われていない 10 件を捨てました（残り 4001 件）"
    );
  });

  test("最後に使った日が壊れた項目だけを採用しない", async () => {
    disk.set(
      cachePath,
      utf8(
        JSON.stringify([
          { key: "無し", createdAt: "2026-08-07T00:00:00.000Z", value: 1 },
          {
            key: "正しい",
            createdAt: "2026-08-07T00:00:00.000Z",
            lastUsedAt: "2026-08-20T00:00:00.000Z",
            value: 2,
          },
          {
            key: "暦に無い日",
            createdAt: "2026-08-07T00:00:00.000Z",
            lastUsedAt: "2026-02-30T00:00:00.000Z",
            value: 3,
          },
          {
            key: "文字列でない",
            createdAt: "2026-08-07T00:00:00.000Z",
            lastUsedAt: 20260820,
            value: 4,
          },
        ])
      )
    );
    const cache = new ChunkCache(work);

    await cache.load();

    expect(cache.size).toBe(2);
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
