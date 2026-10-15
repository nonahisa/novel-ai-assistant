import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { deflateSync } from "node:zlib";
import { COVER_INK_INPUT, coverInk } from "../../../src/mcp/tools/coverInk";
import { exposureOf, setExternalClientName } from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import { McpToolError } from "../../../src/mcp/tools/shared";

/**
 * MCP の `cover.ink`（焼いた表紙の題名の墨を測る。実機確認リスト 5488。2026-10-15）。
 *
 * - 焼いた表紙（設定/書籍/表紙_合成済み.png）を読み、coverBake の結果の titleBlock を
 *   region に渡すと、題名の範囲だけを字ごとに割って「立っているか」まで言う
 * - 色は book.json のその面の題名の色から取る
 * - 作品フォルダーの外は読まない。無い画像は理由を言って断る
 * - **許可の無い作品では門番で断られる**（鍵は run.request と同じ）。返すのは数字だけ
 */

const root = nodePath.join(__dirname, "../../..");
const server = fs.readFileSync(nodePath.join(root, "src/mcp/server.ts"), "utf8");

let temp: string;
let work: string;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** 藍の地に、指定の色の矩形を描いた RGB の PNG */
function png(width: number, height: number, rects: [number, number, number, number, number[]][]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      let color = [30, 50, 110];
      for (const [left, top, w, h, fill] of rects) {
        if (x >= left && x < left + w && y >= top && y < top + h) color = fill;
      }
      raw[at] = color[0];
      raw[at + 1] = color[1];
      raw[at + 2] = color[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const WHITE = [255, 255, 255];
const YELLOW = [250, 220, 40];

function writeBaked(bytes: Buffer, name = "表紙_合成済み.png"): void {
  fs.writeFileSync(nodePath.join(work, "設定", "書籍", name), bytes);
}

beforeEach(() => {
  temp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-coverink-"));
  work = nodePath.join(temp, "作品", "一");
  fs.mkdirSync(nodePath.join(work, "設定", "書籍"), { recursive: true });
  setExternalClientName("claude-code");
});

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("cover.ink", () => {
  test("titleBlock を region に渡すと、題名の範囲だけを測り、向き・1字の大きさもそこから取る", () => {
    // 題名「一」（白い横棒）と、作者名の代わりの白い塊（範囲の外）
    writeBaked(
      png(200, 300, [
        [60, 50, 80, 8, WHITE],
        [150, 260, 30, 30, WHITE],
      ])
    );
    const result = coverInk({
      folder: work,
      region: { left: 40, top: 30, width: 120, height: 60, fontSize: 90, vertical: true, lines: 1 },
      text: "一",
    });
    expect(result.filePath).toBe("設定/書籍/表紙_合成済み.png");
    expect(result.along).toBe("vertical");
    expect(result.bounds).toMatchObject({ left: 60, top: 50, width: 80, height: 8 });
    expect(result.glyphs[0]).toMatchObject({ char: "一", upright: true });
    expect(result.verdict).toBe("upright");
    expect(result.colorSource).toBe("default");
    expect(typeof result.modifiedAt).toBe("string");
  });

  test("色は book.json のその面の題名の色から取る（裏表紙は backCoverLayout）", () => {
    writeBaked(png(100, 100, [[20, 40, 60, 6, YELLOW]]), "裏表紙_合成済み.png");
    fs.writeFileSync(
      nodePath.join(work, "設定", "書籍", "book.json"),
      JSON.stringify({ coverLayout: { title: { color: "#ffffff" } }, backCoverLayout: { title: { color: "#fadc28" } } })
    );
    const result = coverInk({ folder: work, side: "back", along: "horizontal", text: "一" });
    expect(result.colorSource).toBe("book.json");
    expect(result.color).toBe("#fadc28");
    expect(result.bounds).toMatchObject({ left: 20, width: 60 });
  });

  test("焼いた画像が無い・作品の外・PNG でない filePath は、理由を言って断る", () => {
    expect(() => coverInk({ folder: work })).toThrow(/焼いた画像がありません/u);
    expect(() => coverInk({ folder: work, filePath: "..\\..\\秘密.png" })).toThrow(McpToolError);
    expect(() => coverInk({ folder: work, filePath: "設定/書籍/book.json" })).toThrow(/PNG/u);
    writeBaked(Buffer.from("PNG ではない"));
    expect(() => coverInk({ folder: work })).toThrow(/読めませんでした/u);
  });

  test("許可の印が無い作品では門番で断られ、run.request を許せば通る", () => {
    expect(() => assertExternalAccessAllowed({ folder: work }, "cover.ink")).toThrow();
    fs.mkdirSync(nodePath.join(work, ".aiwriter"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(work, ".aiwriter", "external-access.json"),
      JSON.stringify({
        schemaVersion: "2",
        clients: [{ name: "claude-code", tools: ["run.request"], sampling: false, decidedAt: "" }],
      })
    );
    expect(() => assertExternalAccessAllowed({ folder: work }, "cover.ink")).not.toThrow();
  });

  test("原稿は出ない（数字だけ）・サーバーに登録されている・入力の形", () => {
    expect(exposureOf("cover.ink", { folder: work })).toBe("none");
    expect(server).toContain('registerTool(\n  "cover.ink"');
    expect(server).toContain('tool("cover.ink"');
    expect(Object.keys(COVER_INK_INPUT).sort()).toEqual(
      ["along", "cellSize", "color", "filePath", "folder", "region", "side", "text", "tolerance"].sort()
    );
  });
});
