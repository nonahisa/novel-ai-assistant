import { describe, expect, test } from "vitest";
import { jouyouKanjiList, nonJouyouKanjiIn } from "../../src/core/jouyouKanji";

/**
 * 常用漢字表（平成22年内閣告示第2号）の照合（作者の指定、2026-08-28）。
 *
 * 表を手で持つ以上、写し間違いは起こりうる。**総数と重複は機械で数える**——
 * 2,136字ちょうどで重複が無ければ、脱落や二重登録は無い。
 * 字の取り違え（表の字と似た別の字を書いた）までは見つけられないので、
 * 代表的な字の在・不在をスポットで確かめる。
 */
describe("常用漢字表", () => {
  test("総数が2,136字である", () => {
    expect(jouyouKanjiList()).toHaveLength(2136);
  });

  test("重複が無い", () => {
    const list = jouyouKanjiList();
    const unique = new Set(list);
    const duplicated = list.filter(
      (char, index) => list.indexOf(char) !== index
    );
    expect(duplicated, "二重に登録されている字").toEqual([]);
    expect(unique.size).toBe(list.length);
  });

  test("2010年に追加された代表的な字が入っている", () => {
    // 鬱・彙・毀・籠・丼・訃・慄・遡・塡・剝は平成22年の追加組
    for (const char of [...(("鬱彙毀籠丼訃慄遡塡剝") as string)]) {
      expect(nonJouyouKanjiIn(char), char).toEqual([]);
    }
  });

  test("表外の代表的な字を表外と判定する", () => {
    // 悍（悍ましい）・煌・儚・嘘・淚のような字は常用漢字表に無い
    for (const char of [...(("悍煌儚嘘餐") as string)]) {
      expect(nonJouyouKanjiIn(char), char).toEqual([char]);
    }
  });

  test("漢字以外と繰り返し記号は挙げない", () => {
    expect(nonJouyouKanjiIn("ひらがなとカタカナ、記号！？（）と々")).toEqual(
      []
    );
  });

  test("文章から表外の字だけを出現順・重複なしで拾う", () => {
    expect(nonJouyouKanjiIn("悍ましい夜だ。然し悍ましさは煌めきでもある")).toEqual([
      "悍",
      "煌",
    ]);
  });
});
