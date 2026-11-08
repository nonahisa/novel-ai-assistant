import iconv from "iconv-lite";
import { describe, expect, test } from "vitest";
import { decodeBytes } from "../../../src/core/textDecode";
import { encodePreservingFormat } from "../../../src/core/textEncodePreserving";

/**
 * Shift_JIS の原稿へ書き戻すときの字の置き換え（作者の決定 2026-11-08・11-09。設計書5.4.2）。
 *
 * Mac の日本語入力は「〜」（U+301C 波ダッシュ）を出す。Shift_JIS（CP932）にはこの字の符号が無く、
 * 今までは書き戻しが止まっていた。黙って「～」（U+FF5E）へ置き換えて書く。
 */

const sjis = (text: string): Uint8Array => iconv.encode(text, "shift_jis");

function encode(originalText: string, newText: string) {
  const bytes = sjis(originalText);
  const original = decodeBytes(bytes);
  expect(original.encoding).toBe("shift_jis");
  return { bytes, result: encodePreservingFormat(bytes, newText, original) };
}

describe("Shift_JIS への書き戻しで、符号の無い記号を置き換える", () => {
  test("挿した「〜」は 81 60（～）になり、ほかのバイトは1つも動かない", () => {
    const { bytes, result } = encode("灯は～澪を見た。\r\n二行目\r\n", "灯は～澪を〜見た。\n二行目\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 元のバイト列の「を」の後ろに 81 60 が1つ入っただけ
    const insertAt = sjis("灯は～澪を").length;
    const expected = new Uint8Array(bytes.length + 2);
    expected.set(bytes.slice(0, insertAt));
    expected.set([0x81, 0x60], insertAt);
    expected.set(bytes.slice(insertAt), insertAt + 2);
    expect(Array.from(result.bytes)).toEqual(Array.from(expected));
    expect(result.substitutions).toEqual([{ from: "〜", to: "～", count: 1 }]);
  });

  test("記号の8組はどれも置き換えて書ける（— は ―、¥ は ￥）", () => {
    const { result } = encode("あ\n", "あ—−‖¢£¬¥〜〜\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(iconv.decode(Buffer.from(result.bytes), "shift_jis")).toBe(
      "あ―－∥￠￡￢￥～～\n"
    );
    expect(result.substitutions).toContainEqual({ from: "〜", to: "～", count: 2 });
    expect(result.substitutions).toContainEqual({ from: "¥", to: "￥", count: 1 });
  });

  test("Shift_JIS に無い漢字は、似た字が決まっていれば置き換える（𠮟→叱・剝→剥・頰→頬）", () => {
    const { result } = encode("あ\n", "\u{20b9f}る剝がす頰\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(iconv.decode(Buffer.from(result.bytes), "shift_jis")).toBe("叱る剥がす頬\n");
  });

  test("置き換え先の無い字（♡）では止め、どの行のどの前後かを返す", () => {
    const { result } = encode("一行目\n二行目\n", "一行目\n二行目の終わりに♡を置く\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unencodable[0]).toMatchObject({ char: "♡", line: 2 });
    expect(result.unencodable[0].context).toContain("終わりに♡を置く");
  });

  test.each([
    ["❤"],
    ["\u{1f600}"],
    ["〰"],
    ["ゔ"],
    ["ㇰ"],
    ["‑"],
  ])("置き換え先の無い「%s」では止める", (char) => {
    const { result } = encode("あ\n", `あ${char}\n`);
    expect(result.ok).toBe(false);
  });

  test("UTF-8 の原稿では何も置き換えない", () => {
    const bytes = new TextEncoder().encode("あ\n");
    const original = decodeBytes(bytes);
    const result = encodePreservingFormat(bytes, "あ〜¥\n", original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.bytes)).toBe("あ〜¥\n");
    expect(result.substitutions).toEqual([]);
  });
});
