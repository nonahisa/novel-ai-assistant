import { describe, expect, it } from "vitest";
import { swapNameWithAlias } from "../../src/core/settingsEdit";

/**
 * 名前を別名から選べるようにする（設計書6.5.6）。
 *
 * 作者の指示（2026-08-23）：「設定資料の名前欄を別名から選択可能にして
 * ください」。
 *
 * **入れ替えであって、上書きではない。** 元の名前が消えると、本文の照合から
 * 外れ、用語ハイライトもIME辞書もその呼び方を拾わなくなる。
 */

describe("別名から名前を選ぶ", () => {
  it("選んだ別名が名前になり、元の名前が別名へ移る", () => {
    const result = swapNameWithAlias(
      "マルキオ・イークェス",
      "マルキオ",
      ["マルキオ", "隊長"],
      ["マルキオ", "隊長"]
    );
    expect(result.name).toBe("マルキオ");
    expect(result.aliases).toContain("マルキオ・イークェス");
    // 名前になったものは、別名から外れる
    expect(result.aliases).not.toContain("マルキオ");
    // 他の別名は残る
    expect(result.aliases).toContain("隊長");
  });

  /**
   * **打ち間違いの修正で、誤った名前を別名に残さない。**
   * 元から別名にあったものが選ばれたときだけ入れ替える。
   */
  it("別名に無い名前へ変えたときは、元の名前を別名にしない", () => {
    const result = swapNameWithAlias("太史", "太志", ["たいし"], ["たいし"]);
    expect(result.name).toBe("太志");
    expect(result.aliases).toEqual(["たいし"]);
    expect(result.aliases).not.toContain("太史");
  });

  it("名前が変わらなければ、別名もそのまま", () => {
    const result = swapNameWithAlias("灯", "灯", ["ともり"], ["ともり"]);
    expect(result).toEqual({ name: "灯", aliases: ["ともり"] });
  });

  it("元の名前がすでに別名にあれば、二重に足さない", () => {
    const result = swapNameWithAlias(
      "マルキオ・イークェス",
      "マルキオ",
      ["マルキオ", "マルキオ・イークェス"],
      ["マルキオ", "マルキオ・イークェス"]
    );
    expect(
      result.aliases.filter((alias) => alias === "マルキオ・イークェス")
    ).toHaveLength(1);
  });

  /** 同じ保存の中で別名も書き換えられる。作者の入力を尊重する */
  it("別名を書き換えたうえで選んでも、入れ替えは効く", () => {
    const result = swapNameWithAlias(
      "マルキオ・イークェス",
      "マルキオ",
      ["マルキオ", "隊長"],
      ["マルキオ", "副長"]
    );
    expect(result.name).toBe("マルキオ");
    expect(result.aliases).toContain("マルキオ・イークェス");
    // 作者が書き換えた内容が残る
    expect(result.aliases).toContain("副長");
    expect(result.aliases).not.toContain("隊長");
  });

  it("前後の空白は落として比べる", () => {
    const result = swapNameWithAlias(
      "マルキオ・イークェス",
      "  マルキオ  ",
      [" マルキオ "],
      [" マルキオ "]
    );
    expect(result.name).toBe("マルキオ");
    expect(result.aliases).toContain("マルキオ・イークェス");
  });

  it("空の別名は残さない", () => {
    const result = swapNameWithAlias("本名", "通称", ["通称", "  "], [
      "通称",
      "  ",
    ]);
    expect(result.aliases).toEqual(["本名"]);
  });

  it("別名が無ければ、ただ名前が変わるだけ", () => {
    const result = swapNameWithAlias("旧名", "新名", [], []);
    expect(result).toEqual({ name: "新名", aliases: [] });
  });
});
