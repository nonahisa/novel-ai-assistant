import { describe, expect, test } from "vitest";
import {
  fromLfOffset,
  fromLfText,
  toLf,
  toLfOffset,
} from "../../src/core/eolSpace";
import { computeMinimalEdit } from "../../src/core/textEdit";

/**
 * 改行コードの空間の変換（設計書6.34.5の既知の穴の根本修正）。
 *
 * CRLFの原稿で、用語の位置ずれ・ルビが振れない・最初の1打鍵で
 * 改行コードが書き換わる、が同じ根から起きていた。境界での変換が
 * 正しいことを、混在ファイルまで含めて確かめる。
 */

describe("toLf", () => {
  test("CRLFをLFへ直す", () => {
    expect(toLf("あ\r\nい\r\nう")).toBe("あ\nい\nう");
  });

  test("LFだけの本文は変わらない", () => {
    expect(toLf("あ\nい")).toBe("あ\nい");
  });

  test("単独のCRは触らない（対象外と決めてある）", () => {
    expect(toLf("あ\rい")).toBe("あ\rい");
  });
});

describe("位置の対応", () => {
  // LF空間: あ(0) い(1) \n(2) う(3) え(4) \n(5) お(6)
  // 文書側: あ(0) い(1) \r(2)\n(3) う(4) え(5) \r(6)\n(7) お(8)
  const crlf = "あい\r\nうえ\r\nお";

  test("CRLFの文書では、行をまたぐごとに1文字ずつ後ろへ", () => {
    expect(fromLfOffset(crlf, 0)).toBe(0);
    expect(fromLfOffset(crlf, 2)).toBe(2);
    expect(fromLfOffset(crlf, 3)).toBe(4);
    expect(fromLfOffset(crlf, 6)).toBe(8);
    expect(fromLfOffset(crlf, 7)).toBe(9); // 末尾
  });

  test("LFだけの文書では位置がそのまま", () => {
    const lf = "あい\nうえ\nお";
    for (let i = 0; i <= lf.length; i++) {
      expect(fromLfOffset(lf, i)).toBe(i);
      expect(toLfOffset(lf, i)).toBe(i);
    }
  });

  test("混在（CRLFとLFが混ざる）でも正確に対応する", () => {
    // LF空間: a(0) \n(1) b(2) \n(3) c(4)
    // 文書側: a(0) \r(1)\n(2) b(3) \n(4) c(5)
    const mixed = "a\r\nb\nc";
    expect(fromLfOffset(mixed, 2)).toBe(3);
    expect(fromLfOffset(mixed, 4)).toBe(5);
    expect(toLfOffset(mixed, 3)).toBe(2);
    expect(toLfOffset(mixed, 5)).toBe(4);
  });

  test("全位置で往復が一致する", () => {
    const sample = "第一話\r\n{漢字|かんじ}と\n{{強調}}\r\nの本文";
    const lfLength = toLf(sample).length;
    for (let i = 0; i <= lfLength; i++) {
      expect(toLfOffset(sample, fromLfOffset(sample, i))).toBe(i);
    }
  });
});

describe("fromLfText（書き戻しの改行合わせ）", () => {
  test("LFの文書へはそのまま", () => {
    expect(fromLfText("あ\nい", false)).toBe("あ\nい");
  });

  test("CRLFの文書へはCRLFにして返す", () => {
    expect(fromLfText("あ\nい", true)).toBe("あ\r\nい");
  });

  test("既にCRLFが混ざっていても二重にしない", () => {
    expect(fromLfText("あ\r\nい\nう", true)).toBe("あ\r\nい\r\nう");
  });
});

describe("差分と組み合わせたときの改行保持（1打鍵の再現）", () => {
  test("改行を合わせてから差分を取ると、打った1文字だけが変わる", () => {
    // CRLFの原稿「あ↵い」に、画面（LF空間）で「か」を打った
    const documentText = "あ\r\nい";
    const fromScreen = "あか\nい";
    const edit = computeMinimalEdit(
      documentText,
      fromLfText(fromScreen, true)
    );
    expect(edit).toEqual({ start: 1, end: 1, insert: "か" });
  });

  test("合わせずに差分を取ると、置換範囲がCRを飲み込む（直す前の不具合の記録）", () => {
    const documentText = "あ\r\nい";
    const edit = computeMinimalEdit(documentText, "あか\nい");
    // 置き換えられる範囲に \r が入り、差し込みには入らない
    // ＝打鍵のたびに、近くの改行が1つずつLFへ書き換わっていく
    expect(edit).toBeDefined();
    expect(documentText.slice(edit!.start, edit!.end)).toContain("\r");
    expect(edit!.insert).not.toContain("\r");
  });
});
