import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { decodePng, type DecodedPng } from "../../../src/core/pngDecode";
import { measureCoverInk, parseHexColor } from "../../../src/core/coverInk";

/**
 * 焼いた表紙の墨を測る部品（実機確認リスト 5488 を機械で言うため。2026-10-15）。
 *
 * - PNG の読み：canvas が書き出す形（8ビット RGB／RGBA・飛び越しなし）を、行の絞り方
 *   ごとに正しく戻す。読めない形は黙って読み違えずに投げる
 * - 墨の測り：題名の色の画素だけを拾い、範囲の外（作者名など）は見ない。字ごとに割り、
 *   「一」「_」だけは横長かどうかで「立っているか」を言う。言えない題名では言わない
 */

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

/** 画素から PNG を作る。行ごとに絞り方を変えて、戻し方を全部通す */
function encodePng(image: DecodedPng, channels: 3 | 4): Buffer {
  const stride = image.width * channels;
  const pixels = Buffer.alloc(stride * image.height);
  for (let index = 0; index < image.width * image.height; index++) {
    for (let c = 0; c < channels; c++) pixels[index * channels + c] = image.rgba[index * 4 + c];
  }
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const value = pixels[y * stride + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      raw[y * (stride + 1) + 1 + x] = (value - predictor) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 藍の地に、白い矩形をいくつか描いた絵 */
function picture(width: number, height: number, rects: [number, number, number, number][]): DecodedPng {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    rgba[index * 4] = 30 + (index % 7);
    rgba[index * 4 + 1] = 50;
    rgba[index * 4 + 2] = 110 + (index % 13);
    rgba[index * 4 + 3] = 255;
  }
  for (const [left, top, w, h] of rects) {
    for (let y = top; y < top + h; y++) {
      for (let x = left; x < left + w; x++) {
        const at = (y * width + x) * 4;
        rgba[at] = 255;
        rgba[at + 1] = 255;
        rgba[at + 2] = 255;
      }
    }
  }
  return { width, height, rgba };
}

const inflate = (data: Uint8Array): Uint8Array => inflateSync(data);

describe("PNG を読む", () => {
  test("RGB と RGBA を、行の絞り方（0〜4）ごとに正しく戻す", () => {
    const source = picture(37, 23, [[3, 4, 10, 2]]);
    for (const channels of [3, 4] as const) {
      const decoded = decodePng(encodePng(source, channels), inflate);
      expect(decoded.width).toBe(37);
      expect(decoded.height).toBe(23);
      expect(Array.from(decoded.rgba)).toEqual(Array.from(source.rgba));
    }
  });

  test("PNG でないもの・読めない形は、理由を言って投げる", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]), inflate)).toThrow(/PNG ではありません/u);
    const png = encodePng(picture(4, 4, []), 3);
    // 深さを 16 に書き換える（CRC は見ないので読み進む）
    const sixteen = Buffer.from(png);
    sixteen[8 + 8 + 8] = 16;
    expect(() => decodePng(sixteen, inflate)).toThrow(/読めない形/u);
    // 途中で切れた PNG（書きかけを読んだ）
    expect(() => decodePng(png.subarray(0, png.length - 20), inflate)).toThrow(/切れて/u);
  });
});

describe("墨を測る", () => {
  test("色の形", () => {
    expect(parseHexColor("#FFffff")).toEqual([255, 255, 255]);
    expect(parseHexColor("white")).toBeUndefined();
    expect(() => measureCoverInk(picture(4, 4, []), { color: "white" })).toThrow(/色の形/u);
  });

  test("範囲の中の題名の色だけを拾い、外の同じ色（作者名）は見ない", () => {
    // 題名「一」（横棒）を上に、作者名の代わりの白い塊を下に置く
    const image = picture(200, 300, [
      [60, 50, 80, 8],
      [150, 260, 30, 30],
    ]);
    const report = measureCoverInk(image, {
      color: "#ffffff",
      region: { left: 0, top: 0, width: 200, height: 150 },
      along: "vertical",
      text: "一",
    });
    expect(report.bounds).toMatchObject({ left: 60, top: 50, width: 80, height: 8 });
    expect(report.glyphs).toHaveLength(1);
    expect(report.glyphs[0]).toMatchObject({ char: "一", probe: "wide", upright: true });
    expect(report.verdict).toBe("upright");
    expect(report.paired).toBe(true);
  });

  test("横倒しの「一」（縦長の墨）は rotated と言う（2026-10-15 に直した不具合の形）", () => {
    const image = picture(200, 300, [[96, 40, 8, 80]]);
    const report = measureCoverInk(image, { color: "#ffffff", along: "vertical", text: "一" });
    expect(report.glyphs[0].upright).toBe(false);
    expect(report.verdict).toBe("rotated");
  });

  test("縦に並べた題名を字ごとに割る。1字の中の空き（「二」）では割らない", () => {
    // 1字 40px。1字目は「二」の形（上下2本）、2字目は「一」
    const image = picture(100, 200, [
      [30, 12, 40, 4],
      [30, 34, 40, 4],
      [30, 64, 40, 4],
    ]);
    const report = measureCoverInk(image, {
      color: "#ffffff",
      along: "vertical",
      cellSize: 40,
      text: "二一",
    });
    expect(report.glyphs).toHaveLength(2);
    expect(report.glyphs.map((glyph) => glyph.char)).toEqual(["二", "一"]);
    expect(report.glyphs[0]).toMatchObject({ top: 12, bottom: 37 });
    // 「二」は形で向きを言える字ではない。「一」だけで言う
    expect(report.glyphs[0].probe).toBeUndefined();
    expect(report.glyphs[1].upright).toBe(true);
    expect(report.verdict).toBe("upright");
  });

  test("横に並べた題名を、列の空きで字ごとに割る", () => {
    const image = picture(300, 100, [
      [20, 40, 40, 5],
      [80, 30, 10, 30],
      [140, 40, 40, 5],
    ]);
    const report = measureCoverInk(image, {
      color: "#ffffff",
      along: "horizontal",
      cellSize: 45,
      text: "一|一",
    });
    expect(report.glyphs.map((glyph) => [glyph.left, glyph.right])).toEqual([
      [20, 59],
      [80, 89],
      [140, 179],
    ]);
    expect(report.glyphs[1].aspect).toBeLessThan(1);
    expect(report.verdict).toBe("upright");
  });

  test("形で向きを言えない題名・字の数が合わないときは、判定せずに数字だけ返す", () => {
    const image = picture(100, 100, [[30, 30, 40, 40]]);
    const square = measureCoverInk(image, { color: "#ffffff", along: "vertical", text: "口" });
    expect(square.verdict).toBe("unknown");
    expect(square.glyphs[0].aspect).toBe(1);
    expect(square.notes.join("")).toContain("判定していません");

    const mismatch = measureCoverInk(image, { color: "#ffffff", along: "vertical", text: "一一" });
    expect(mismatch.paired).toBe(false);
    expect(mismatch.glyphs[0].char).toBeUndefined();
    expect(mismatch.notes.join("")).toContain("組にしていません");
  });

  test("墨が無ければ null と、確かめる所を言う", () => {
    const report = measureCoverInk(picture(50, 50, []), { color: "#ffffff", along: "vertical" });
    expect(report.bounds).toBeNull();
    expect(report.inkPixels).toBe(0);
    expect(report.notes.join("")).toContain("墨がありません");
  });
});
