/**
 * SHA-1 / SHA-256 を、Node にもブラウザにも頼らずに計算する（設計書5.8）。
 *
 * **ブラウザ版のVS Code（vscode.dev）には `node:crypto` が無い。** 代わりに
 * Web Crypto があるが、**あちらは非同期しか無い。**
 *
 * ここを非同期にすると、`hashText` を呼んでいる原稿保護の照合
 * （読み込み時のハッシュと書き戻す直前のハッシュを突き合わせる）が
 * すべて非同期になる。**原稿を壊さないための仕組みを、移植のついでに
 * 作り替えることになる。** それは危ない。
 *
 * だから同期のまま動く実装を持つ。**正しさは Node の `crypto` と
 * 突き合わせて確かめる**（`test/unit/hash.test.ts`）。自分で書いた
 * 暗号の実装を、自分のテストだけで正しいと言わない。
 */

/** SHA-256 の定数（最初の64個の素数の立方根の小数部） */
// prettier-ignore
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 右回転。JavaScript のシフトは符号付きなので、最後に `>>> 0` で戻す */
function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/**
 * 末尾に詰め物をする。
 *
 * 0x80 を1つ置き、長さが64で割って56余るまで0を並べ、
 * 最後に「元の長さ（ビット数）」を8バイトの大きい桁から順に置く。
 */
function padded(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const totalLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const out = new Uint8Array(totalLength);
  out.set(bytes);
  out[bytes.length] = 0x80;

  // **ビット数は32ビットに収まらないことがある。** 上下に分けて置く
  const view = new DataView(out.buffer);
  view.setUint32(totalLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(totalLength - 4, bitLength >>> 0, false);
  return out;
}

/** 32ビットの並びを、16進の文字列にする */
function toHex(words: Uint32Array): string {
  let out = "";
  for (const word of words) {
    out += word.toString(16).padStart(8, "0");
  }
  return out;
}

export function sha256Bytes(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const message = padded(bytes);
  const view = new DataView(message.buffer, message.byteOffset, message.length);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K256[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return toHex(h);
}

export function sha1Bytes(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0,
  ]);
  const message = padded(bytes);
  const view = new DataView(message.buffer, message.byteOffset, message.length);
  const w = new Uint32Array(80);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }

  return toHex(h);
}

/**
 * 文字列をUTF-8のバイト列にする。
 *
 * `TextEncoder` は Node にもブラウザにもある。**`Buffer` は Node だけ**
 * なので使わない。
 */
const encoder = new TextEncoder();

export function sha256Text(text: string): string {
  return sha256Bytes(encoder.encode(text));
}

export function sha1Text(text: string): string {
  return sha1Bytes(encoder.encode(text));
}
