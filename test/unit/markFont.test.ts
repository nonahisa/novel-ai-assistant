import { describe, expect, test } from "vitest";
import {
  MARK_FONT_GOTHIC,
  MARK_FONT_MINCHO,
  markFontFor,
} from "../../src/core/markFont";
import { MANUSCRIPT_FONTS } from "../../src/core/manuscriptFonts";

/**
 * ダッシュ「――」と三点リーダ「……」に当てる書体（設計書6.34）。
 *
 * 作者が実機で書体を替えて「――」を見た（2026-09-21）。
 * **游明朝・ＭＳ 明朝・游ゴシックだけ隙間が出て、VS Code の等幅では
 * 「…」の見え方が変**だった。この3＋1だけを同系の繋がる書体へ倒し、
 * ほかは作者の書体のまま出す——名指しで固定すると、別の明朝を選んだ
 * 作者の本文の中で**そこだけ書体が変わる**（0.64.4 で直した不具合）。
 */

/** 選べる一覧から、その名前の設定値を引く（設定の綴りを写さない） */
function valueOf(label: string): string {
  const found = MANUSCRIPT_FONTS.find((font) => font.label === label);
  if (!found) throw new Error(`一覧に「${label}」が無い`);
  return found.value;
}

describe("隙間の出る書体は、同系の繋がる書体へ倒す", () => {
  test("游明朝 → 明朝の列", () => {
    expect(markFontFor(valueOf("游明朝"))).toBe(MARK_FONT_MINCHO);
  });

  test("ＭＳ 明朝 → 明朝の列", () => {
    expect(markFontFor(valueOf("ＭＳ 明朝"))).toBe(MARK_FONT_MINCHO);
  });

  test("游ゴシック → ゴシックの列", () => {
    expect(markFontFor(valueOf("游ゴシック"))).toBe(MARK_FONT_GOTHIC);
  });

  test("VS Codeの編集用フォント（等幅）→ ゴシックの列", () => {
    // 作者の実機では「…」の見え方が変だった。等幅は欧文書体なので、
    // 和文の印を任せられない
    expect(markFontFor(valueOf("VS Codeの編集用フォント"))).toBe(
      MARK_FONT_GOTHIC
    );
  });

  test("設定へ手で書いた等幅も、名前で拾う", () => {
    // 一覧に無い綴り（Cascadia Mono など）も等幅なら同じ扱いにする
    expect(markFontFor('"Cascadia Mono", monospace')).toBe(MARK_FONT_GOTHIC);
    expect(markFontFor("Consolas")).toBe(MARK_FONT_GOTHIC);
  });

  test("倒し先は、作者の実機で「繋がる」と確かめた書体だけで組む", () => {
    // BIZ UD・Noto・ヒラギノ・メイリオ。ここへ游やＭＳを混ぜると、
    // 入っている端末でまた隙間が出る
    for (const list of [MARK_FONT_MINCHO, MARK_FONT_GOTHIC]) {
      expect(list).not.toMatch(/Yu\s?Mincho|MS\s?Mincho|Yu\s?Gothic|MS\s?Gothic/);
    }
  });
});

describe("困らない書体は、作者の書体のまま", () => {
  test("Noto Serif JP はそのまま", () => {
    const value = valueOf("Noto Serif JP");
    expect(markFontFor(value)).toBe(value);
  });

  test("Noto Sans JP はそのまま", () => {
    const value = valueOf("Noto Sans JP");
    expect(markFontFor(value)).toBe(value);
  });

  test("BIZ UD明朝・ヒラギノ明朝・メイリオもそのまま", () => {
    for (const label of ["BIZ UD明朝", "ヒラギノ明朝", "メイリオ"]) {
      expect(markFontFor(valueOf(label)), label).toBe(valueOf(label));
    }
  });

  test("空（既定にまかせる）は空のまま", () => {
    // 変数を立てない。CSS側の逃げ先（var の第2引数）がこれまでどおり効く
    expect(markFontFor("")).toBe("");
    expect(markFontFor("   ")).toBe("");
  });
});

describe("綴りの揺れ", () => {
  test("引用符・空白の有無と大文字小文字で見分けを変えない", () => {
    // 游明朝は Windows で "Yu Mincho"、macOS で "YuMincho" と名乗る
    expect(markFontFor("YuMincho, serif")).toBe(MARK_FONT_MINCHO);
    expect(markFontFor('"yu mincho", serif')).toBe(MARK_FONT_MINCHO);
  });

  test("見るのは並びの先頭だけ", () => {
    // 実際に描かれるのは先頭の1つ。逃げ先に serif が並んでいても、
    // 先頭が繋がる書体ならそのまま使う
    expect(markFontFor('"BIZ UDMincho", "Yu Mincho", serif')).toBe(
      '"BIZ UDMincho", "Yu Mincho", serif'
    );
  });
});
