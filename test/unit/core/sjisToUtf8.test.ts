import iconv from "iconv-lite";
import { describe, expect, test } from "vitest";
import { decodeBytes } from "../../../src/core/textDecode";
import { chooseUtf8Bom, planUtf8Conversion } from "../../../src/core/sjisToUtf8";

/**
 * Shift_JIS の原稿を UTF-8 にするバイト列の作り方（設計書5.4.2、0.149.0）。
 *
 * 確かめること：**本文の字は1字も変わらない・改行のバイトも1つも変わらない**
 * （混在も、末尾の改行の有無も）。変わるのは字の符号と、先頭の BOM だけ。
 */
const sjis = (text: string): Uint8Array => iconv.encode(text, "shift_jis");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const BOM = [0xef, 0xbb, 0xbf];

function converted(bytes: Uint8Array, bom = false): Uint8Array {
  const plan = planUtf8Conversion(bytes, { bom });
  if (plan.kind !== "convert") throw new Error(`変換されなかった：${plan.reason}`);
  return plan.bytes;
}

describe("Shift_JIS の原稿を UTF-8 のバイト列にする", () => {
  test.each([
    ["CRLF・末尾改行あり", "灯は言った。\r\n「①から始めよう」\r\n"],
    ["LF・末尾改行なし", "髙橋と﨑山\n～と―"],
    ["CR", "古い\r改行\r"],
    ["混在（CRLF・LF・CR）", "甲\r\n乙\n丙\r丁"],
  ])("%s：本文と改行のバイトはそのまま", (_label, text) => {
    const before = sjis(text);
    const after = converted(before);
    // 改行も混在もそのまま（LF に揃えた本文から組み直すと、混在が潰れる）
    expect(after).toEqual(utf8(text));
    const read = decodeBytes(after);
    expect(read.encoding).toBe("utf8");
    expect(read.text).toBe(decodeBytes(before).text);
    expect(read.eol).toBe(decodeBytes(before).eol);
    expect(read.hasMixedEol).toBe(decodeBytes(before).hasMixedEol);
    expect(read.hasTrailingNewline).toBe(decodeBytes(before).hasTrailingNewline);
  });

  test("BOM を付けるときは先頭の3バイトだけが増える", () => {
    const after = converted(sjis("灯\r\n"), true);
    expect([...after.slice(0, 3)]).toEqual(BOM);
    expect(after.slice(3)).toEqual(utf8("灯\r\n"));
    expect(decodeBytes(after).encoding).toBe("utf8-bom");
  });

  test("CP932 の重複する符号（NEC 選定 IBM 拡張）も、読んだ字のまま UTF-8 にする", () => {
    // ED40 と FA5C は同じ字（纊）。バイトの往復で比べると、正しい原稿まで飛ばしてしまう
    const bytes = new Uint8Array([0xed, 0x40, 0x0d, 0x0a]);
    expect(converted(bytes)).toEqual(utf8("纊\r\n"));
  });

  test("Shift_JIS として読めないバイト（0xA0・0xFD・途中で切れた2バイト目）がある話は変えない", () => {
    for (const broken of [
      new Uint8Array([...sjis("灯"), 0xa0, 0x0a]),
      new Uint8Array([...sjis("灯"), 0xfd, 0x0a]),
      new Uint8Array([...sjis("灯\n"), 0x82]),
      new Uint8Array([...sjis("灯"), 0x80, 0x0a]),
    ]) {
      // まず、製品の読み方で Shift_JIS と判定される（UTF-8 として不正）ことを確かめる
      expect(decodeBytes(broken).encoding).toBe("shift_jis");
      expect(planUtf8Conversion(broken, { bom: false })).toEqual({ kind: "skip", reason: "undecodable" });
    }
  });

  test("すでに UTF-8 の話は変えない", () => {
    expect(planUtf8Conversion(utf8("灯\n"), { bom: false })).toEqual({ kind: "skip", reason: "not_shift_jis" });
    expect(planUtf8Conversion(new Uint8Array([...BOM, ...utf8("灯")]), { bom: false })).toEqual({
      kind: "skip",
      reason: "not_shift_jis",
    });
  });

  test("競合の印（<<<<<<<）が残っている話は変えない", () => {
    const bytes = sjis("<<<<<<< HEAD\n灯\n=======\n澪\n>>>>>>> other\n");
    expect(planUtf8Conversion(bytes, { bom: false })).toEqual({ kind: "skip", reason: "conflict_markers" });
  });
});

describe("BOM を付けるか", () => {
  test("作品のほかの UTF-8 の話が無ければ、BOM なし", () => {
    expect(chooseUtf8Bom([], undefined)).toEqual({ bom: false, reason: "no_others" });
  });

  test("ほかの UTF-8 の話の多いほうに合わせる（同数なら BOM なし）", () => {
    expect(chooseUtf8Bom(["utf8-bom", "utf8-bom", "utf8"], "utf8")).toEqual({ bom: true, reason: "match_others" });
    expect(chooseUtf8Bom(["utf8", "utf8", "utf8-bom"], "utf8")).toEqual({ bom: false, reason: "match_others" });
    expect(chooseUtf8Bom(["utf8", "utf8-bom"], "utf8")).toEqual({ bom: false, reason: "match_others" });
  });

  test("Shift_JIS の話は数えない", () => {
    expect(chooseUtf8Bom(["shift_jis", "shift_jis"], undefined)).toEqual({ bom: false, reason: "no_others" });
  });

  test("設定 files.encoding が shiftjis なら、ほかの話によらず BOM を付ける", () => {
    // BOM が無いと VS Code がこの設定で Shift_JIS と読み、化けた本文を開く（保存すると原稿が壊れる）
    expect(chooseUtf8Bom(["utf8", "utf8"], "shiftjis")).toEqual({ bom: true, reason: "setting_shiftjis" });
    expect(chooseUtf8Bom([], "shiftjis")).toEqual({ bom: true, reason: "setting_shiftjis" });
  });
});
