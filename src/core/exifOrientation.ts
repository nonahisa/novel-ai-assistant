/**
 * 写真に付いている向きの印（EXIF の Orientation）を読む（設計書6.117.3、2026-10-11）。
 * VS Code にも Node にも依存しない（ブラウザ版でも同じ道で動く。規則7）。
 *
 * ## 回すのは画面の描き方に任せる
 *
 * 写真から原稿を起こす画面（WebView）は Chromium で描く。Chromium は `<img>`・
 * `drawImage`・`createImageBitmap` のどれでも、**この印を当てて正しい向きに描く**
 * （2026-10-11、Chromium 153 で向き6に書き換えた写真を読ませて確かめた：
 * 格納 2576×1932 の写真が 1932×2576 で描かれた。`imageOrientation: "from-image"` も同じ）。
 * ここで回すと二重に回るので、画面は「自動で回した」ことを出すのにだけ使う。
 *
 * ## 読むのは JPEG だけ
 *
 * スマホの写真の向きの印は JPEG の APP1（Exif）に入る。PNG・WebP は
 * 読まない（印が無いのと同じ扱い）。**壊れた並びは推測せずに読まない**
 * ——読み違えて回すより、作者が90度ずつ直すほうが害が小さい。
 */

/** EXIF の向きの値（1〜8）。2・4・5・7 は鏡に映した向き */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** 向きの値から、正しい向きにするために右へ回す角度と、鏡映しかを決める */
export function rotationForOrientation(orientation: number): {
  readonly degrees: 0 | 90 | 180 | 270;
  readonly mirrored: boolean;
} {
  switch (orientation) {
    case 2:
      return { degrees: 0, mirrored: true };
    case 3:
      return { degrees: 180, mirrored: false };
    case 4:
      return { degrees: 180, mirrored: true };
    case 5:
      return { degrees: 90, mirrored: true };
    case 6:
      return { degrees: 90, mirrored: false };
    case 7:
      return { degrees: 270, mirrored: true };
    case 8:
      return { degrees: 270, mirrored: false };
    default:
      // 1（そのまま）と、知らない値。知らない値で回さない
      return { degrees: 0, mirrored: false };
  }
}

/**
 * JPEG のバイト列から向きの値を読む。印が無い・JPEG でない・壊れている
 * ときは undefined。
 */
export function readExifOrientation(bytes: Uint8Array): ExifOrientation | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    // 画像の本体（SOS）より後ろに印は無い
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    if (marker === 0xe1) {
      const found = readFromApp1(view, offset + 4, length - 2);
      if (found !== undefined) return found;
    }
    offset += 2 + length;
  }
  return undefined;
}

/** APP1 の中身（`Exif\0\0` から）を読む */
function readFromApp1(view: DataView, start: number, size: number): ExifOrientation | undefined {
  // "Exif" + 0x00 0x00
  if (size < 14) return undefined;
  const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  for (let k = 0; k < header.length; k++) {
    if (view.getUint8(start + k) !== header[k]) return undefined;
  }
  const tiff = start + 6;
  const end = start + size;
  const order = view.getUint16(tiff);
  // "II" は小さい桁から、"MM" は大きい桁から
  const little = order === 0x4949 ? true : order === 0x4d4d ? false : undefined;
  if (little === undefined) return undefined;
  if (view.getUint16(tiff + 2, little) !== 42) return undefined;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return undefined;
  const count = view.getUint16(ifd, little);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return undefined;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? (value as ExifOrientation) : undefined;
  }
  return undefined;
}
