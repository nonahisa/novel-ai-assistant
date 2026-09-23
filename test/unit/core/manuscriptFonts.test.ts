import { describe, expect, test } from "vitest";
import {
  MANUSCRIPT_FONTS,
  alwaysAvailable,
  describeCurrentFont,
  findFont,
  listChoices,
} from "../../src/core/manuscriptFonts";

/**
 * 原稿の書体（作者の依頼、2026-08-27）。
 *
 * 設定は 0.19.0 からあったが、**設定ファイルへCSSの書式で手打ちする**形で、
 * しかも**開き直すまで効かなかった**。「できる」と「できると分かる」は別である。
 */

describe("選べる書体", () => {
  test("明朝を先に並べる", () => {
    // 縦書きの本文は明朝で読む。ゴシックが先にあると、既定を外したくなる
    const kinds = MANUSCRIPT_FONTS.map((font) => font.kind);
    const firstGothic = kinds.indexOf("ゴシック");
    const lastMincho = kinds.lastIndexOf("明朝");

    expect(lastMincho).toBeLessThan(firstGothic);
  });

  test("先頭は既定（何も選ばない状態）", () => {
    // 設定を空に戻す道が無いと、一度選んだら既定へ帰れない
    expect(MANUSCRIPT_FONTS[0].value).toBe("");
    expect(alwaysAvailable(MANUSCRIPT_FONTS[0])).toBe(true);
  });

  test("端末の書体に頼るものは、測らない", () => {
    // 既定と等幅は逃げ先そのものなので、測っても意味がない
    for (const font of MANUSCRIPT_FONTS) {
      if (font.kind === "既定" || font.kind === "等幅") {
        expect(alwaysAvailable(font), font.label).toBe(true);
      } else {
        expect(font.probe, font.label).toBeTruthy();
      }
    }
  });

  test("測る名前は、値の先頭と揃える", () => {
    // ずれると「入っていない」と出しながら、その書体で描かれる
    for (const font of MANUSCRIPT_FONTS) {
      if (!font.probe) continue;
      expect(font.value, font.label).toContain(font.probe);
    }
  });
});

describe("いまの書体を見分ける", () => {
  test("引用符や空白の違いは同じものとして見る", () => {
    // 設定へ手で書いた値と見比べるため
    expect(findFont("'Yu Mincho',   'YuMincho', serif")?.label).toBe("游明朝");
  });

  test("一覧に無い値でも、設定は尊重する", () => {
    // 作者が手で書いた書体を、選び直すまで消さない
    expect(findFont("Comic Sans MS")).toBeUndefined();
    expect(describeCurrentFont("Comic Sans MS")).toContain("Comic Sans MS");
  });

  test("空なら既定と読む", () => {
    expect(describeCurrentFont("")).toContain("既定");
  });
});

describe("選ばせる並び", () => {
  test("入っていない書体も並べて、そう書けるようにする", () => {
    // 消すと「あるはずのものが無い」に見え、なぜ選べないのか分からない
    const choices = listChoices("", new Set(["Yu Mincho"]));
    const yu = choices.find((font) => font.label === "游明朝");
    const hiragino = choices.find((font) => font.label === "ヒラギノ明朝");

    expect(yu?.installed).toBe(true);
    expect(hiragino?.installed).toBe(false);
    // 並びからは落とさない
    expect(choices).toHaveLength(MANUSCRIPT_FONTS.length);
  });

  test("測れなかったときは、全部を選べるままにする", () => {
    // 「測れない」を「入っていない」と読み替えると、選べるものが消える
    const choices = listChoices("", undefined);

    expect(choices.every((font) => font.installed)).toBe(true);
  });

  test("いま選ばれているものに印を付ける", () => {
    const choices = listChoices('"Yu Mincho", "YuMincho", serif');

    expect(choices.filter((font) => font.selected).map((font) => font.label)).toEqual([
      "游明朝",
    ]);
  });

  test("一覧に無い値のときは、どれにも印を付けない", () => {
    expect(listChoices("Comic Sans MS").some((font) => font.selected)).toBe(false);
  });
});
