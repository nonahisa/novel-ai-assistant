/**
 * EPUBエディターの写真を撮る件が共通に使う部品（`epubLook.test.ts`・`coverTitleLook.test.ts`）。
 *
 * 元は `epubLook.test.ts` の中にあった。表紙の長い題名の写真（束 E22、2026-10-15）でも
 * 同じ見本の絵と同じ開き方が要るので、写しを作らずここへ出した。
 */
import { inflateSync, deflateSync } from "node:zlib";
import type { Frame, Page } from "playwright-core";
import { runCommand } from "../support/quickInput";
import { E2E_WORK_TITLE } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { pickQuickPickRow, quickPickTitle } from "../support/workbenchDom";

/** PNG の CRC32 */
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

/** 縦に濃い藍から薄い水色へ変わる、400×560 の見本の絵（元イラストの代わり） */
export function samplePicture(): Buffer {
  const width = 400;
  const height = 560;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    const t = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const at = rowStart + 1 + x * 3;
      raw[at] = Math.round(30 + 150 * t);
      raw[at + 1] = Math.round(50 + 150 * t);
      raw[at + 2] = Math.round(110 + 120 * t);
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

/** 読み終えた PNG（8ビット・飛び越しなし）。画素は RGBA に揃える */
export interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

/**
 * 焼いた表紙（canvas の書き出し）を読む。**8ビットの RGB／RGBA・飛び越しなしだけ**を読む
 * （canvas が書き出すのはこの形。違う形なら黙って読み違えず、投げる）
 */
export function decodePng(bytes: Buffer): DecodedPng {
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(`読めない形の PNG です（深さ ${bitDepth}・色の型 ${colorType}・飛び越し ${interlace}）`);
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: pixels };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = pixels[i * 3];
    rgba[i * 4 + 1] = pixels[i * 3 + 1];
    rgba[i * 4 + 2] = pixels[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

export async function epubFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("railBook") !== null && document.getElementById("blockList") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

export async function railLabels(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll("#blockList .rail-row")).map((row) => (row.querySelector(".rail-label")?.textContent ?? "").trim())
  );
}

/** EPUBエディターを開く。作品を選ぶ画面が出たら `workTitle` の行を選ぶ */
export async function openEpubEditor(page: Page, workTitle: string = E2E_WORK_TITLE): Promise<Frame> {
  await runCommand(page, "EPUBエディター（試作）");
  await page.waitForTimeout(500);
  if ((await quickPickTitle(page)) !== undefined) await pickQuickPickRow(page, workTitle);
  let found: Frame | undefined;
  await waitUntil(async () => {
    found = await epubFrame(page);
    return found !== undefined && (await railLabels(found)).length > 0;
  }, "EPUBエディターが開いて本の並びが出る", 30_000);
  return found as Frame;
}
