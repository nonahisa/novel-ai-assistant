import { describe, expect, test } from "vitest";
import {
  computeDocumentEdit,
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

/**
 * 改行が混在するファイルで、1文字打つ（作者の原稿を壊さないための要）。
 *
 * ## 何が起きていたか
 *
 * `applyEdit` は画面の本文（LF空間）を `fromLfText(next, CRLF)` で
 * **全部CRLFに直してから**差分を取っていた。CRLFの文書にLFだけの行が
 * 混ざっていると（マージや貼り付けの名残でふつうに起きる）、揃えた側と
 * 文書側は**その行から**食い違う。前方一致はそこで止まるので、
 *
 *   3行目（LFのまま）から、いま打った200行目まで
 *
 * が丸ごと「差分」になり、**触っていない3〜5行目の改行が書き換わる。**
 * 1文字打っただけで、である（実装ルール1「改行コードを保持して書き戻す」）。
 */
describe("computeDocumentEdit（混在ファイルで1文字打つ）", () => {
  /** 1〜200行目がCRLF、ただし3〜5行目だけLF、という文書を作る */
  function mixedDocument(): string {
    const lines: string[] = [];
    for (let i = 1; i <= 200; i++) lines.push(`${i}行目`);
    return lines
      .map((line, index) => {
        if (index === lines.length - 1) return line;
        // 添字2,3,4 ＝ 3〜5行目の行末だけLF
        return line + (index >= 2 && index <= 4 ? "\n" : "\r\n");
      })
      .join("");
  }

  test("触っていない行の改行を書き換えない", () => {
    const documentText = mixedDocument();
    // 画面はLF空間。200行目の末尾に「あ」を打った
    const nextLf = toLf(documentText).replace("200行目", "200行目あ");

    const edit = computeDocumentEdit(documentText, nextLf, true);

    expect(edit).toBeDefined();
    // **置き換えるのは200行目の1点だけ。** 3〜5行目まで巻き込まない
    expect(edit!.insert).toBe("あ");
    expect(edit!.start).toBe(edit!.end);
    // 当てたあとも、3〜5行目のLFはLFのまま残る
    const applied =
      documentText.slice(0, edit!.start) +
      edit!.insert +
      documentText.slice(edit!.end);
    expect(applied).toContain("2行目\r\n3行目\n4行目\n5行目\n6行目\r\n");
    expect(applied).toContain("200行目あ");
  });

  test("直す前のやり方だと、混在の行まで差分に入る（不具合の記録）", () => {
    const documentText = mixedDocument();
    const nextLf = toLf(documentText).replace("200行目", "200行目あ");

    // 文書ぜんたいをCRLFへ揃えてから差分を取っていた
    const old = computeMinimalEdit(documentText, fromLfText(nextLf, true));

    expect(old).toBeDefined();
    // 3行目の行末（LF）から差分が始まり、**触っていない行を飲み込む**
    expect(old!.end - old!.start).toBeGreaterThan(1000);
    expect(documentText.slice(old!.start, old!.end)).toContain("4行目");
  });

  test("新しく作る改行は、文書の改行コードに従う", () => {
    // 混在は保てない（どの行がどちらだったかはLF空間に残らない）が、
    // **新しく入れる改行**は文書の宣言に合わせる。
    // 位置は文書の空間（`あ\r\n` のあと＝3）で返る
    const edit = computeDocumentEdit("あ\r\nい", "あ\n\nい", true);

    expect(edit).toEqual({ start: 3, end: 3, insert: "\r\n" });
  });

  test("LFの文書には、LFのまま入れる", () => {
    const edit = computeDocumentEdit("あ\nい", "あ\n\nい", false);

    expect(edit).toEqual({ start: 2, end: 2, insert: "\n" });
  });

  test("変わっていなければ何も返さない", () => {
    expect(computeDocumentEdit("あ\r\nい", "あ\nい", true)).toBeUndefined();
  });
});
