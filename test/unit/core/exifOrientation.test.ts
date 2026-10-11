import { describe, expect, test } from "vitest";
import {
  readExifOrientation,
  rotationForOrientation,
} from "../../../src/core/exifOrientation";

/**
 * 写真の向きの印（EXIF の Orientation）。設計書6.117.3。
 *
 * 写真はテストに入れない。最小の JPEG の頭（SOI と APP1）だけを組み立てて読む。
 */

/** 向きの値を1つだけ持つ APP1 を組み立てる */
function jpegWithOrientation(
  orientation: number | undefined,
  order: "II" | "MM" = "II"
): Uint8Array {
  const little = order === "II";
  const entries = orientation === undefined ? 0 : 1;
  const tiffSize = 8 + 2 + entries * 12 + 4;
  const app1Body = 6 + tiffSize;
  const bytes = new Uint8Array(2 + 4 + app1Body + 4);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xe1], 0);
  view.setUint16(4, app1Body + 2);
  bytes.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6);
  const tiff = 12;
  bytes.set(little ? [0x49, 0x49] : [0x4d, 0x4d], tiff);
  view.setUint16(tiff + 2, 42, little);
  view.setUint32(tiff + 4, 8, little);
  view.setUint16(tiff + 8, entries, little);
  if (orientation !== undefined) {
    const entry = tiff + 10;
    view.setUint16(entry, 0x0112, little);
    view.setUint16(entry + 2, 3, little); // SHORT
    view.setUint32(entry + 4, 1, little);
    view.setUint16(entry + 8, orientation, little);
  }
  // 画像の本体の印（SOS）。ここから後ろは読まない
  bytes.set([0xff, 0xda, 0x00, 0x02], bytes.length - 4);
  return bytes;
}

describe("向きの値から回す角度を決める", () => {
  test("8つの値の表", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(rotationForOrientation)).toEqual([
      { degrees: 0, mirrored: false },
      { degrees: 0, mirrored: true },
      { degrees: 180, mirrored: false },
      { degrees: 180, mirrored: true },
      { degrees: 90, mirrored: true },
      { degrees: 90, mirrored: false },
      { degrees: 270, mirrored: true },
      { degrees: 270, mirrored: false },
    ]);
  });

  test("知らない値では回さない", () => {
    for (const value of [0, 9, -1, Number.NaN]) {
      expect(rotationForOrientation(value)).toEqual({ degrees: 0, mirrored: false });
    }
  });
});

describe("JPEG から向きの値を読む", () => {
  test("小さい桁から（II）でも大きい桁から（MM）でも読める", () => {
    for (const value of [1, 3, 6, 8]) {
      expect(readExifOrientation(jpegWithOrientation(value, "II"))).toBe(value);
      expect(readExifOrientation(jpegWithOrientation(value, "MM"))).toBe(value);
    }
  });

  test("向きの欄が無い・JPEG でない・範囲外の値なら読まない", () => {
    expect(readExifOrientation(jpegWithOrientation(undefined))).toBeUndefined();
    expect(readExifOrientation(jpegWithOrientation(9))).toBeUndefined();
    expect(readExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(readExifOrientation(new Uint8Array([]))).toBeUndefined();
  });

  test("APP1 の前に別の印（APP0）があっても読む", () => {
    const exif = jpegWithOrientation(6);
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
    const bytes = new Uint8Array(exif.length + app0.length);
    bytes.set(exif.subarray(0, 2), 0);
    bytes.set(app0, 2);
    bytes.set(exif.subarray(2), 2 + app0.length);
    expect(readExifOrientation(bytes)).toBe(6);
  });

  test("長さの壊れた並びは推測せずに読まない", () => {
    const bytes = jpegWithOrientation(6);
    // APP1 の長さを本体より長くする
    new DataView(bytes.buffer).setUint16(4, 0xfff0);
    expect(readExifOrientation(bytes)).toBeUndefined();
    // 途中で切れた写真
    expect(readExifOrientation(jpegWithOrientation(6).subarray(0, 20))).toBeUndefined();
  });

  test("ずらした位置から始まるバイト列（Buffer の切り出し）でも読める", () => {
    const exif = jpegWithOrientation(8);
    const padded = new Uint8Array(exif.length + 7);
    padded.set(exif, 7);
    expect(readExifOrientation(padded.subarray(7))).toBe(8);
  });
});
