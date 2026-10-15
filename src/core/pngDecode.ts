/**
 * PNG を画素（RGBA）に戻す（焼いた表紙を測るため。2026-10-15）。
 *
 * **読むのは 8ビットの RGB／RGBA・飛び越しなしだけ**——canvas の `toDataURL` が書き出す
 * 形はこれである。違う形を黙って読み違えると、測った数字がもっともらしい嘘になるので、
 * 理由を言って投げる。
 *
 * **圧縮の解き方（inflate）は渡してもらう。** この部品は VS Code にも Node にも依存しない
 * （MCP の束からも使う。`test/unit/cross/mcpReach.test.ts`）。MCP サーバーは
 * `node:zlib` の `inflateSync` を渡す。画面の自動テストの物差し（`test/e2e/look/epubLookSupport.ts`）
 * もこれを呼ぶ——写しを2つ持つと、片方だけ直る日が来る。
 */

export interface DecodedPng {
  width: number;
  height: number;
  /** 1画素4バイト（R・G・B・A）。RGB の PNG は A を 255 で埋める */
  rgba: Uint8Array;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 寸法の上限（焼いた表紙は 1714×2400。桁違いのものは読まない＝メモリを使い切らない） */
const MAX_PIXELS = 40_000_000;

function readUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function latin1(bytes: Uint8Array, from: number, to: number): string {
  let text = "";
  for (let index = from; index < to; index++) text += String.fromCharCode(bytes[index]);
  return text;
}

export function decodePng(
  bytes: Uint8Array,
  inflate: (data: Uint8Array) => Uint8Array
): DecodedPng {
  if (bytes.length < 8 || PNG_MAGIC.some((value, index) => bytes[index] !== value)) {
    throw new Error("PNG ではありません（先頭の印が違います）。");
  }
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  let idatLength = 0;
  while (at + 8 <= bytes.length) {
    const length = readUint32(bytes, at);
    const type = latin1(bytes, at + 4, at + 8);
    if (at + 12 + length > bytes.length) {
      throw new Error("PNG が途中で切れています（書きかけを読んだかもしれません）。");
    }
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      const bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(
          `読めない形の PNG です（深さ ${bitDepth}・色の型 ${colorType}・飛び越し ${interlace}）。` +
            "焼いた表紙（8ビットの RGB／RGBA）だけを読みます。"
        );
      }
      if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) {
        throw new Error(`PNG の寸法が読めません（${width}×${height}）。`);
      }
    } else if (type === "IDAT") {
      idat.push(data);
      idatLength += data.length;
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (colorType < 0) throw new Error("PNG の見出し（IHDR）がありません。");

  const joined = new Uint8Array(idatLength);
  let offset = 0;
  for (const part of idat) {
    joined.set(part, offset);
    offset += part.length;
  }
  const raw = inflate(joined);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new Error("PNG の画素が足りません（書きかけを読んだかもしれません）。");
  }

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = raw[lineStart + x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`PNG の行の絞り方（${filter}）が読めません。`);
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    rgba[index * 4] = pixels[index * 3];
    rgba[index * 4 + 1] = pixels[index * 3 + 1];
    rgba[index * 4 + 2] = pixels[index * 3 + 2];
    rgba[index * 4 + 3] = 255;
  }
  return { width, height, rgba };
}
