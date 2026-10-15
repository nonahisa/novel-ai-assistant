/**
 * 画面の自動テストが使う小さな写真（PNG）をその場で作る（設計書6.113）。
 *
 * **作者の写真は使わない。** 写真から原稿を起こす画面（設計書6.117）の件は、横長・縦長と
 * 左右の塗り分けだけが分かればよいので、決まった色で塗った小さな絵をテストの中で作る。
 * JPEG は作るのに符号器が要るので、無圧縮に近い PNG（8ビットの RGB・飛び越しなし・
 * 行ごとの前処理なし）にした。製品は png も写真として受ける（`features/photoTranscribe.ts` の
 * `IMAGE_TYPES`）。
 *
 * EPUB の写真の件（`look/epubLookSupport.ts`）にも同じ形の作り方があるが、あちらは
 * 見本の絵と読み戻しが組になっていて、色を指定して塗る口が無いので、ここに分けて置く。
 */
import { deflateSync } from "node:zlib";

/** 1画素の色（0〜255 の赤・緑・青） */
export type Rgb = readonly [number, number, number];

/** PNG の CRC32（チャンクの型＋中身に掛ける） */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
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

/**
 * 幅 `width`・高さ `height` の PNG を、画素ごとに `paint(x, y)` の色で塗って作る。
 */
export function paintedPng(width: number, height: number, paint: (x: number, y: number) => Rgb): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    // 行ごとの前処理は「なし」（0）。小さな絵なので縮みの良し悪しは問わない
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const at = rowStart + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 1色8ビット
  header[9] = 2; // RGB（透明なし）
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
