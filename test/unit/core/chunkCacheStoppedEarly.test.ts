import { describe, expect, test } from "vitest";
import {
  ChunkCacheStore,
  type CacheKeyBase,
  type ChunkCacheIo,
} from "../../../src/core/chunkCacheStore";

/**
 * 同じ要素の繰り返しで途中止めした答え（`GenerateResult.stoppedEarly`）を
 * 控えに残すとき、**途中止めだったと後から分かる印**が残るか
 * （作者の裁定、2026-10-10。設計書6.77 の 15）。
 *
 * 印は鍵に入れない（同じ本文を印の有無で2回送らないため）。ここで見るのは
 *
 * - 印は保存して読み直しても残る
 * - 印の無い控えには欄そのものを書かない（古い形式と同じ姿のまま）
 * - 別のプロセス（MCPサーバー）が書いた印も、混ぜ直しで消えない
 * - 読めない形の印は、印が無いものとして扱う
 */

const FILE = "C:/works/作品/.aiwriter/cache/chunks.json";

const base: CacheKeyBase = {
  feature: "typo_check",
  promptVersion: "1",
  providerId: "ollama",
  model: "gemma4:26b",
};

const MARK = { reason: "repetition" as const, stoppedAt: 6, kept: 2 };

/** 1つのファイルを2つのプロセスで共有する形を、手元の Map で写す */
function memoryDisk(): { io: ChunkCacheIo; raw: () => unknown[] } {
  let bytes: Uint8Array | undefined;
  return {
    io: {
      async read() {
        return bytes;
      },
      async write(_file, next) {
        bytes = next;
      },
      log() {},
    },
    raw: () =>
      bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as unknown[]) : [],
  };
}

describe("控えの途中止めの印", () => {
  test("印は保存して読み直しても残り、中身もそのまま返る", async () => {
    const disk = memoryDisk();
    const writer = new ChunkCacheStore(FILE, disk.io);
    await writer.load();
    await writer.set("h1", base, { issues: [{ line: 1 }] }, { stoppedEarly: MARK });
    await writer.save();

    const reader = new ChunkCacheStore(FILE, disk.io);
    await reader.load();
    expect(reader.get("h1", base)).toEqual({ issues: [{ line: 1 }] });
    expect(reader.stoppedEarlyOf("h1", base)).toEqual(MARK);
  });

  test("印の無い控えには欄を書かない", async () => {
    const disk = memoryDisk();
    const store = new ChunkCacheStore(FILE, disk.io);
    await store.load();
    await store.set("h1", base, { issues: [] });
    await store.save();

    const [entry] = disk.raw() as Array<Record<string, unknown>>;
    expect("stoppedEarly" in entry).toBe(false);
    expect(store.stoppedEarlyOf("h1", base)).toBeUndefined();
  });

  test("印は鍵に入らない（同じ本文の控えは印の有無に関わらず1つ）", async () => {
    const disk = memoryDisk();
    const store = new ChunkCacheStore(FILE, disk.io);
    await store.load();
    await store.set("h1", base, { issues: [] }, { stoppedEarly: MARK });
    // 次に書き切った答えで上書きされたら、印は消える
    await store.set("h1", base, { issues: [{ line: 3 }] });
    expect(store.size).toBe(1);
    expect(store.stoppedEarlyOf("h1", base)).toBeUndefined();
  });

  test("別のプロセスが書いた印は、こちらの保存で混ぜ直しても消えない", async () => {
    const disk = memoryDisk();
    const mcp = new ChunkCacheStore(FILE, disk.io);
    const extension = new ChunkCacheStore(FILE, disk.io);
    await mcp.load();
    await extension.load();

    await mcp.set("h1", base, { issues: [] }, { stoppedEarly: MARK });
    await mcp.save();
    await extension.set("h2", base, { issues: [] });
    await extension.save();

    const reader = new ChunkCacheStore(FILE, disk.io);
    await reader.load();
    expect(reader.stoppedEarlyOf("h1", base)).toEqual(MARK);
    expect(reader.stoppedEarlyOf("h2", base)).toBeUndefined();
  });

  test("印を覗くだけでは当たったことにしない（最後に使った日を進めない）", async () => {
    const disk = memoryDisk();
    let now = new Date("2026-10-01T00:00:00.000Z");
    const store = new ChunkCacheStore(FILE, disk.io, { now: () => now });
    await store.load();
    await store.set("h1", base, { issues: [] }, { stoppedEarly: MARK });
    await store.save();

    now = new Date("2026-10-05T00:00:00.000Z");
    const reader = new ChunkCacheStore(FILE, disk.io, { now: () => now });
    await reader.load();
    expect(reader.stoppedEarlyOf("h1", base)).toEqual(MARK);
    await reader.save();
    const [entry] = disk.raw() as Array<Record<string, unknown>>;
    expect(entry.lastUsedAt).toBeUndefined();
  });

  test("読めない形の印は、印が無いものとして扱う", async () => {
    const disk = memoryDisk();
    await disk.io.write(
      FILE,
      new TextEncoder().encode(
        JSON.stringify([
          {
            key: "dummy",
            createdAt: "2026-10-10T00:00:00.000Z",
            value: {},
          },
        ])
      )
    );
    const store = new ChunkCacheStore(FILE, disk.io);
    await store.load();
    await store.set("h1", base, {}, { stoppedEarly: MARK });
    await store.save();
    // 手で書き換えられた印（理由が知らない値）
    const entries = disk.raw() as Array<Record<string, unknown>>;
    for (const entry of entries) {
      if (entry.stoppedEarly) entry.stoppedEarly = { reason: "?", stoppedAt: "6" };
    }
    await disk.io.write(FILE, new TextEncoder().encode(JSON.stringify(entries)));

    const reader = new ChunkCacheStore(FILE, disk.io);
    await reader.load();
    expect(reader.get("h1", base)).toEqual({});
    expect(reader.stoppedEarlyOf("h1", base)).toBeUndefined();
  });
});
