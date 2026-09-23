import { describe, expect, test } from "vitest";
import { findNameOccurrences } from "../../src/core/nameOccurrences";

describe("登場箇所の走査（設計書6.37.4）", () => {
  test("長い名前を先に当て、重なりは長いほうを取る", () => {
    // 「ミナモト」を「ミナ」＋「モト」に割ると、付け替えで本文が壊れる
    const found = findNameOccurrences("ミナモトが来た。ミナは笑った。", [
      "ミナ",
      "ミナモト",
    ]);
    expect(found.map((entry) => entry.name)).toEqual(["ミナモト", "ミナ"]);
    expect(found[0].start).toBe(0);
    expect(found[1].start).toBe(8);
  });

  test("ルビの中も対象にする（baseと読みの両方）", () => {
    // ルビを外してから探すと、付け替えのときにルビの中だけ旧名が残る
    const text = "｜東雲《しののめ》と{東雲|しののめ}。";
    const found = findNameOccurrences(text, ["東雲", "しののめ"]);
    expect(found.filter((entry) => entry.name === "東雲")).toHaveLength(2);
    expect(found.filter((entry) => entry.name === "しののめ")).toHaveLength(2);
  });

  test("行番号は1始まりで、列は行頭からの位置", () => {
    const text = "一行目\nここにアリアが居た\n三行目";
    const [found] = findNameOccurrences(text, ["アリア"]);
    expect(found.line).toBe(2);
    expect(found.column).toBe(3);
  });

  test("前後の文を同じ行から取る", () => {
    const text = "ここにアリアが居た";
    const [found] = findNameOccurrences(text, ["アリア"]);
    expect(found.before).toBe("ここに");
    expect(found.after).toBe("が居た");
  });

  test("前後は行をまたがない", () => {
    const text = "前の行\nアリア\n次の行";
    const [found] = findNameOccurrences(text, ["アリア"]);
    expect(found.before).toBe("");
    expect(found.after).toBe("");
  });

  test("同じ名前が何度出ても全部拾う", () => {
    const found = findNameOccurrences("アリアとアリア\nアリア", ["アリア"]);
    expect(found).toHaveLength(3);
    expect(found.map((entry) => entry.line)).toEqual([1, 1, 2]);
  });

  test("名前が空なら何も返さない", () => {
    expect(findNameOccurrences("アリア", ["", "  "])).toEqual([]);
    expect(findNameOccurrences("", ["アリア"])).toEqual([]);
  });
});
