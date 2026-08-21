import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import { sha1Bytes, sha1Text, sha256Bytes, sha256Text } from "../../src/core/hash";

/**
 * 自前のハッシュが、Node の `crypto` と1文字も違わないことを確かめる（設計書5.7）。
 *
 * **ブラウザ版には `node:crypto` が無く、Web Crypto は非同期しか無い。**
 * 同期のまま動く実装を自分で書いたので、**正しさは他人の実装と
 * 突き合わせて示す。** 自分のテストだけで「合っています」と言わない。
 *
 * ここが1ビットでもずれると、**原稿を守るハッシュ照合が常に不一致になり、
 * AIの修正がまったく適用できなくなる**（あるいは、外部で編集された原稿を
 * 変更なしと見なして上書きする）。
 */

/** Node の実装。これを正解とする */
function nodeSha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function nodeSha1(bytes: Uint8Array): string {
  return crypto.createHash("sha1").update(bytes).digest("hex");
}

describe("公表されている値と一致する", () => {
  // RFC やNISTが出している既知の値。Node すら通さずに確かめる
  it("空の入力", () => {
    expect(sha256Text("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(sha1Text("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("abc", () => {
    expect(sha256Text("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(sha1Text("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });
});

describe("詰め物の境目", () => {
  /**
   * **ここがいちばん壊れやすい。** 末尾の詰め物は64バイトの区切りに
   * 合わせて入れるので、55/56/57 と 63/64/65 で通る道が変わる。
   */
  const 境目 = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129];

  for (const length of 境目) {
    it(`${length}バイト`, () => {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 0xff;
      expect(sha256Bytes(bytes)).toBe(nodeSha256(bytes));
      expect(sha1Bytes(bytes)).toBe(nodeSha1(bytes));
    });
  }
});

describe("日本語の本文", () => {
  it("マルチバイトでも一致する", () => {
    const 本文 = [
      "呪詛だらけの学校は視界が悪いので、引き寄せて確保する。",
      "「あんた、一応報告なんだけど、さっき身体が勝手に動いて」",
      "｛漢字｜かんじ｝のルビ記法",
      "改行\r\nを含む\n混ざった本文",
      "絵文字🌸とサロゲートペア𠮷",
    ].join("\n");
    expect(sha256Text(本文)).toBe(nodeSha256(new TextEncoder().encode(本文)));
    expect(sha1Text(本文)).toBe(nodeSha1(new TextEncoder().encode(本文)));
  });

  it("1話ぶんの長さでも一致する", () => {
    // 実データは1話あたり2,000〜3,000字ある
    const 一話 = "あの日の教室は、いやに静かだった。".repeat(200);
    expect(sha256Text(一話)).toBe(nodeSha256(new TextEncoder().encode(一話)));
  });
});

describe("手当たり次第に試しても一致する", () => {
  it("長さも中身もばらばらの300件", () => {
    // **境目だけ合わせて通るような実装になっていないか。**
    // 種を固定して、落ちたときに同じものを再現できるようにする
    let seed = 20260821;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let n = 0; n < 300; n++) {
      const length = Math.floor(random() * 500);
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = Math.floor(random() * 256);
      expect(sha256Bytes(bytes), `${n}件目 / ${length}バイト`).toBe(
        nodeSha256(bytes)
      );
      expect(sha1Bytes(bytes), `${n}件目 / ${length}バイト`).toBe(
        nodeSha1(bytes)
      );
    }
  });
});

describe("元のバイト列を書き換えない", () => {
  it("詰め物のために呼び出し元の配列を触らない", () => {
    // **本文のバイト列をそのまま渡す場所がある。** 書き換えたら原稿が壊れる
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const copy = Uint8Array.from(bytes);
    sha256Bytes(bytes);
    sha1Bytes(bytes);
    expect(Array.from(bytes)).toEqual(Array.from(copy));
  });

  it("大きな配列の一部を渡しても一致する", () => {
    // subarray はもとの器を共有する。オフセットを取り違えると値が変わる
    const whole = new Uint8Array(200);
    for (let i = 0; i < whole.length; i++) whole[i] = i & 0xff;
    const part = whole.subarray(37, 140);
    expect(sha256Bytes(part)).toBe(nodeSha256(part));
    expect(sha1Bytes(part)).toBe(nodeSha1(part));
  });
});
