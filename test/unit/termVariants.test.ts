import { describe, expect, test } from "vitest";
import { TermIndex, expandNameVariants } from "../../src/core/termIndex";

describe("本文に現れる呼び方への展開", () => {
  test("中黒で区切られた姓名を分ける", () => {
    // 本文には「マルキオ」としか出てこないことが多い
    expect(expandNameVariants(["マルキオ・イークェス"])).toEqual([
      "マルキオ・イークェス",
      "マルキオ",
      "イークェス",
    ]);
  });

  test("空白区切りも分ける", () => {
    expect(expandNameVariants(["黒木 玲司"])).toEqual([
      "黒木 玲司",
      "黒木",
      "玲司",
    ]);
  });

  test("区切りが無い名前は切らない", () => {
    // 推測で切ると別人の名前と重なって誤って色が付く
    expect(expandNameVariants(["ホンゴー"])).toEqual(["ホンゴー"]);
  });

  test("1文字の部分は広げない", () => {
    // 普通名詞と重なりやすい
    expect(expandNameVariants(["王・リンセップ"])).toEqual([
      "王・リンセップ",
      "リンセップ",
    ]);
  });

  test("重複を取り除く", () => {
    expect(expandNameVariants(["マルキオ・イークェス", "マルキオ"])).toEqual([
      "マルキオ・イークェス",
      "マルキオ",
      "イークェス",
    ]);
  });
});

describe("短い名前に食われないこと", () => {
  function index(entries: Array<{ text: string; id: string }>) {
    return new TermIndex(
      entries.map((entry) => ({
        text: entry.text,
        kind: "character" as const,
        id: entry.id,
        canonicalName: entry.text,
      }))
    );
  }

  test("フルネームの一部を登録すれば長いほうが優先される", () => {
    // 「マル」と「マルキオ・イークェス」が別レコードとして存在する状況。
    // 展開しないと「マルキオ」の先頭2文字だけが色付いていた
    const entries = [
      { text: "マル", id: "char_002" },
      ...expandNameVariants(["マルキオ・イークェス"]).map((text) => ({
        text,
        id: "char_004",
      })),
    ];

    const matches = index(entries).find("騎士マルキオは剣を抜いた。");

    expect(matches).toHaveLength(1);
    expect(matches[0].entry.text).toBe("マルキオ");
    expect(matches[0].entry.id).toBe("char_004");
  });

  test("短い名前そのものは今までどおり一致する", () => {
    const entries = [
      { text: "マル", id: "char_002" },
      ...expandNameVariants(["マルキオ・イークェス"]).map((text) => ({
        text,
        id: "char_004",
      })),
    ];

    const matches = index(entries).find("「マル、こっちだ」");

    expect(matches).toHaveLength(1);
    expect(matches[0].entry.id).toBe("char_002");
  });

  test("リンとリンセップでも同じ", () => {
    const entries = [
      { text: "リン", id: "char_001" },
      ...expandNameVariants(["リンセップ・アウクト"]).map((text) => ({
        text,
        id: "char_003",
      })),
    ];

    const matches = index(entries).find("王女リンセップは扇を閉じた。");

    expect(matches[0].entry.text).toBe("リンセップ");
    expect(matches[0].entry.id).toBe("char_003");
  });
});
