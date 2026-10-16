import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  externalChunksOfText,
  formatExtractStash,
  parseExtractStashEntries,
  withStashEntries,
  type ExtractStashEntry,
} from "../../../src/core/externalExtractStash";
import { decodeBytes } from "../../../src/core/textDecode";
import { chunkFromId, chunkIdOf } from "../../../src/mcp/tools/shared";
import { extractStashFileOf, readExtractStash } from "../../../src/mcp/tools/extractStash";
import { replayChunksOf } from "../../../src/mcp/tools/extractCommit";
import { CHARACTER_EXTRACT_VERSION } from "../../../src/prompts/characterExtract";

/**
 * 外から頼む設定資料の抽出（`run.request` feature: settings。2026-10-16）の貯め方。
 *
 * **拡張機能が貯めた答えを、MCP の `novel.extract.commit` がそのまま使えること。**
 * 保存の道（`replayChunksOf`）は `chunkId` から本文を切り直し、ハッシュが合わない
 * 答えを「本文が変わった」として捨てる。拡張機能の側が製品の［設定資料を抽出］と
 * 同じ切り方（まとめ送信）で切ると、**全部が黙って捨てられる**——ここで見張る。
 *
 * 2つのプロセス（拡張機能と MCP サーバー）にまたがる約束なので `cross/` に置く。
 */

let temp: string;
let work: string;

const SOLO = "第1話　はじまり\n\n" + "ミナは駅へ走った。\n".repeat(400);
/**
 * 合本（1ファイルに何話も入っている）。chunk.index が話ごとに0から振り直される形。
 * MCP の合本の試験（`mcpChunkId.test.ts`）と同じ作り物を使う
 */
const COLLECTED = fs.readFileSync(
  nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work", "本文", "collected.txt")
);

beforeEach(() => {
  temp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-run-settings-"));
  work = nodePath.join(temp, "星の町");
  fs.mkdirSync(nodePath.join(work, "本文"), { recursive: true });
  fs.writeFileSync(nodePath.join(work, "本文", "第1話.txt"), SOLO);
  fs.writeFileSync(nodePath.join(work, "本文", "合本.txt"), COLLECTED);
});

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

function chunksOfFile(relative: string, maxChars: number) {
  const text = decodeBytes(fs.readFileSync(nodePath.join(work, relative))).text;
  return externalChunksOfText(relative, text, maxChars);
}

describe("拡張機能が切ったチャンクを、MCP が同じチャンクとして切り直せる", () => {
  test("ばらのファイル：名前もハッシュも一致する（いくつかに切れる大きさで）", () => {
    const relative = nodePath.join("本文", "第1話.txt");
    const items = chunksOfFile(relative, 1500);
    expect(items.length).toBeGreaterThan(1);
    for (const item of items) {
      expect(item.chunkId).toBe(chunkIdOf(relative, item.chunk, 1500));
      expect(chunkFromId(work, item.chunkId).hash).toBe(item.chunk.hash);
    }
  });

  test("合本：話ごとに名前が分かれ、それぞれ同じ本文に当たる", () => {
    const relative = nodePath.join("本文", "合本.txt");
    const items = chunksOfFile(relative, 6000);
    expect(new Set(items.map((item) => item.chunkId)).size).toBe(items.length);
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(chunkFromId(work, item.chunkId).hash).toBe(item.chunk.hash);
    }
  });
});

describe("拡張機能が書いた貯め場所を、MCP の保存の道が読める", () => {
  test("書いた形を MCP が読み、保存の道で1件も捨てない", () => {
    const relative = nodePath.join("本文", "第1話.txt");
    const entries: ExtractStashEntry[] = chunksOfFile(relative, 1500).map((item) => ({
      chunkId: item.chunkId,
      chunkHash: item.chunk.hash,
      promptVersion: CHARACTER_EXTRACT_VERSION,
      parsed: { characters: [] } as never,
      savedAt: "2026-10-16T00:00:00.000Z",
    }));
    const file = extractStashFileOf(work);
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatExtractStash(entries), "utf8");

    const read = readExtractStash(work);
    expect(read.map((entry) => entry.chunkId)).toEqual(entries.map((entry) => entry.chunkId));
    const replay = replayChunksOf(work, read);
    expect(replay.discarded).toEqual([]);
    expect(replay.chunks).toHaveLength(entries.length);
  });

  test("同じ chunkId は差し替える（MCP の stash と同じ）・ほかは残す", () => {
    const base = (chunkId: string, savedAt: string): ExtractStashEntry => ({
      chunkId,
      chunkHash: "h",
      promptVersion: CHARACTER_EXTRACT_VERSION,
      parsed: { characters: [] } as never,
      savedAt,
    });
    const merged = withStashEntries(
      [base("a", "1"), base("b", "1")],
      [base("b", "2"), base("c", "2")]
    );
    expect(merged.map((entry) => `${entry.chunkId}:${entry.savedAt}`)).toEqual(["a:1", "b:2", "c:2"]);
  });

  test("壊れた貯め場所は読めないと返す（黙って空として上書きしない）", () => {
    expect(parseExtractStashEntries(JSON.parse(formatExtractStash([])))).toEqual([]);
    expect(parseExtractStashEntries({ entries: [{ chunkId: 1 }] })).toBeUndefined();
    expect(parseExtractStashEntries([])).toBeUndefined();
    expect(parseExtractStashEntries(null)).toBeUndefined();
  });
});
