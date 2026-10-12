import { describe, expect, test } from "vitest";
import {
  PHOTO_REQUEST_FILE_NAME,
  PHOTO_REQUEST_MAX_CHARS,
  checkPhotoRequest,
  countPhotoRequestChars,
  formatPhotoRequestFile,
  parsePhotoRequestFile,
  photoRequestEchoes,
} from "../../../src/core/photoTranscribeRequest";

/**
 * 写真の書き起こしの「AIへの頼み」の純粋な部分（設計書6.117.7。作者の裁定、2026-10-12）。
 *
 * 守るのは4つ。
 * 1. 上限（300字）を超えたら、黙って切らずに断る
 * 2. 改行はそのまま
 * 3. 置き場のファイルが壊れていたら、直さずに理由を返す
 * 4. 同期で2つの版が混ざった印（競合マーカー）は、壊れとは別の理由で言う
 */

describe("頼みの上限", () => {
  test("上限は300字", () => {
    expect(PHOTO_REQUEST_MAX_CHARS).toBe(300);
  });

  test("ちょうど上限までは通す", () => {
    const check = checkPhotoRequest("あ".repeat(PHOTO_REQUEST_MAX_CHARS));
    expect(check.ok).toBe(true);
  });

  test("超えたら、黙って切らずに理由（字数）を返す", () => {
    const check = checkPhotoRequest("あ".repeat(PHOTO_REQUEST_MAX_CHARS + 1));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("300字を超えています（301字）");
  });

  test("絵文字などは1字に数える（画面の Array.from と揃える）", () => {
    expect(countPhotoRequestChars("𠮷野家")).toBe(3);
    expect(checkPhotoRequest("𠮷".repeat(PHOTO_REQUEST_MAX_CHARS)).ok).toBe(true);
  });

  test("文字列でないものは空の頼みとして扱う", () => {
    expect(checkPhotoRequest(undefined)).toEqual({ ok: true, text: "" });
    expect(checkPhotoRequest(42)).toEqual({ ok: true, text: "" });
  });

  test("CRLF は LF にそろえ、前後の空白は落とす（中の改行はそのまま）", () => {
    expect(checkPhotoRequest("\r\n 一行目\r\n二行目 \r\n")).toEqual({ ok: true, text: "一行目\n二行目" });
  });
});

describe("頼みの返りを捨てるための行", () => {
  test("空の行を除き、行ごとに前後の空白を落とす", () => {
    expect(photoRequestEchoes(" 旧字体はそのまま\n\n ルビは（）に ")).toEqual([
      "旧字体はそのまま",
      "ルビは（）に",
    ]);
    expect(photoRequestEchoes("")).toEqual([]);
  });
});

describe("置き場のファイルの形", () => {
  test("ファイル名は .aiwriter の直下の photo-transcribe-request.json", () => {
    expect(PHOTO_REQUEST_FILE_NAME).toBe("photo-transcribe-request.json");
  });

  test("書いた形をそのまま読み戻せる（改行もそのまま）", () => {
    const text = "旧字体はそのまま。\nルビの小さい字は（）に入れる。";
    const file = formatPhotoRequestFile(text);
    expect(file.endsWith("\n")).toBe(true);
    expect(parsePhotoRequestFile(file)).toEqual({ ok: true, text });
  });

  test("先頭の BOM は中身ではないので落として読む", () => {
    expect(parsePhotoRequestFile(`﻿${formatPhotoRequestFile("頼み")}`)).toEqual({ ok: true, text: "頼み" });
  });

  test("request が無ければ空の頼み", () => {
    expect(parsePhotoRequestFile('{ "version": 1 }')).toEqual({ ok: true, text: "" });
  });

  test("上限を超えた文も切らずに返す（画面と［書き起こす］の確かめが縮めてと言う）", () => {
    const long = "あ".repeat(PHOTO_REQUEST_MAX_CHARS + 5);
    expect(parsePhotoRequestFile(formatPhotoRequestFile(long))).toEqual({ ok: true, text: long });
  });

  test("壊れた JSON は直さずに理由を返す", () => {
    const read = parsePhotoRequestFile('{ "request": "頼み"');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.kind).toBe("broken");
    expect(read.reason).toContain(PHOTO_REQUEST_FILE_NAME);
    expect(read.reason).toContain("直さずに");
  });

  test("形の違うもの（配列・request が文字列でない）も壊れとして止める", () => {
    expect(parsePhotoRequestFile("[]").ok).toBe(false);
    expect(parsePhotoRequestFile("null").ok).toBe(false);
    expect(parsePhotoRequestFile('{ "request": 3 }').ok).toBe(false);
  });

  test("競合マーカーは JSON として読む前に見つけ、同期で混ざったと言う", () => {
    const conflicted = [
      "<<<<<<< HEAD",
      '{ "version": 1, "request": "旧字体はそのまま" }',
      "=======",
      '{ "version": 1, "request": "ルビは（）に" }',
      ">>>>>>> origin/main",
      "",
    ].join("\n");
    const read = parsePhotoRequestFile(conflicted);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.kind).toBe("conflict");
    expect(read.reason).toContain("同期で2つの版が混ざった");
  });
});
