import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { nodeOutboxIo } from "../../../src/mcp/tools/outbox";

/**
 * 出先の原稿箱の取り込みの口（`nodeOutboxIo`）が、作品フォルダーの外を読み書きしない
 * （セキュリティ点検 2026-11-21）。
 *
 * 本文の書き戻しと読み出しは前から `resolveInsideFolder` を通していたが、
 * `readText` と `appendJsonLines` だけが `path.join` で素のまま繋いでいた。
 * 相対パスは取り込む記録から来るので、`..` を含む値で外のファイルを読み・足せた。
 */

let base: string;
let folder: string;

beforeEach(() => {
  base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "outbox-inside-"));
  folder = nodePath.join(base, "作品");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(nodePath.join(base, "外の秘密.txt"), "外にある", "utf8");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("原稿箱の取り込みの口は、作品フォルダーの外へ出ない", () => {
  it("readText は外を指す相対パスを断る（undefined に化けさせない）", async () => {
    const io = nodeOutboxIo(folder);
    await expect(io.readText("../外の秘密.txt")).rejects.toThrow("作品フォルダーの外");
  });

  it("readText は中の無いファイルなら undefined のまま", async () => {
    const io = nodeOutboxIo(folder);
    expect(await io.readText(".aiwriter/無い.json")).toBeUndefined();
  });

  it("appendJsonLines は外を指す相対パスを断り、何も作らない", async () => {
    const io = nodeOutboxIo(folder);
    await expect(io.appendJsonLines("../外へ足す.jsonl", [{ a: 1 }])).rejects.toThrow(
      "作品フォルダーの外"
    );
    expect(fs.existsSync(nodePath.join(base, "外へ足す.jsonl"))).toBe(false);
  });

  it("appendJsonLines は中なら足せる", async () => {
    const io = nodeOutboxIo(folder);
    await io.appendJsonLines(".aiwriter/記録.jsonl", [{ a: 1 }]);
    expect(fs.readFileSync(nodePath.join(folder, ".aiwriter", "記録.jsonl"), "utf8")).toContain(
      '"a":1'
    );
  });
});
