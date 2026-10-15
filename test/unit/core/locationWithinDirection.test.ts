import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { withinDirectionFromQuote } from "../../../src/core/locationWithinDirection";
import { validateExtractedLocations } from "../../../src/core/settingsExtractionValidation";

/**
 * 「中にある」（within）の向きを引用の文の形から確かめる（作者の裁定 2026-10-15 の7）。
 *
 * 発端：gemma4:26b が「死の谷の奥にあるという温泉」を5回とも
 * 「死の谷 within 温泉」（谷が温泉の中）と逆に読み、検算は引用の実在しか
 * 見ないので通っていた。**見逃しと誤検出の両方を見る**——逆は拾い、
 * 正しい向きと形から読めないものには触らない。
 */

describe("引用の形から向きを読む", () => {
  test("逆向き：「Xの奥にあるという Y」で、X within Y と言っている", () => {
    expect(
      withinDirectionFromQuote("「死の谷の奥にあるという温泉の調査のためですの。」", ["死の谷"], ["温泉"])
    ).toBe("reversed");
  });

  test("正しい向き：同じ引用で、温泉 within 死の谷", () => {
    expect(withinDirectionFromQuote("死の谷の奥にあるという温泉", ["温泉"], ["死の谷"])).toBe(
      "consistent"
    );
  });

  test.each([
    ["王宮の宝物殿に飾ってあった宝剣", "宝物殿", "王宮"],
    ["学校の体育倉庫にいるよ", "体育倉庫", "学校"],
    ["港町の外れに港がある", "港", "港町"],
    ["図書塔は王都の中にある", "図書塔", "王都"],
    ["帝都の中の貴族街", "貴族街", "帝都"],
  ])("正しい向き：%s", (quote, self, target) => {
    expect(withinDirectionFromQuote(quote, [self], [target])).toBe("consistent");
  });

  test.each([
    ["王宮の宝物殿に飾ってあった宝剣", "王宮", "宝物殿"],
    ["港町の外れに港がある", "港町", "港"],
    ["図書塔は王都の中にある", "王都", "図書塔"],
  ])("逆向き：%s", (quote, self, target) => {
    expect(withinDirectionFromQuote(quote, [self], [target])).toBe("reversed");
  });

  test.each([
    // 片方の名前がもう片方の名前の一部（長い名前の中の「庭園」は数えない）
    ["一人で庭園のあずまやでお茶している", "庭園のあずまや", "庭園"],
    // 間に挟まる語が位置の語でない
    ["帝都には街を囲む城壁があり、門からしか出入りできない", "城壁", "帝都"],
    // 方角は「中」ではない
    ["学校は港の北に建っている", "学校", "港"],
    ["港の北の学校", "学校", "港"],
    // 相手の名前が無い
    ["この村で3階建てなのはここだけで", "領主の館", "村"],
  ])("形から読めないものには触らない：%s", (quote, self, target) => {
    expect(withinDirectionFromQuote(quote, [self], [target])).toBe("unknown");
  });

  test("別名でも向きを読む", () => {
    expect(withinDirectionFromQuote("谷の奥にあるという温泉", ["死の谷", "谷"], ["温泉"])).toBe(
      "reversed"
    );
  });
});

describe("検算：逆向きは相手の場所へ付け替える", () => {
  const chunk: Chunk = {
    filePath: "006.txt",
    index: 0,
    text: "「死の谷の奥にあるという温泉の調査のためですの。」\n死の谷は帝都の北にある。",
    startLine: 0,
    hash: "fixture",
    chapterStart: 6,
    chapterEnd: 6,
  };
  const valley = (relations: unknown[]) => ({
    name: "死の谷",
    evidence: "死の谷の奥にあるという温泉",
    relations,
  });
  const spring = (relations: unknown[] = []) => ({
    name: "温泉",
    evidence: "死の谷の奥にあるという温泉",
    relations,
  });
  const reversedRelation = {
    target: "温泉",
    kind: "within",
    value: null,
    evidence: "「死の谷の奥にあるという温泉の調査のためですの。」",
  };

  test("26b の答えの形（死の谷 within 温泉）は、温泉 within 死の谷 になる", () => {
    const result = validateExtractedLocations([valley([reversedRelation]), spring()], chunk);
    const byName = new Map(result.accepted.map((entry) => [entry.data.name, entry.data]));
    expect(byName.get("死の谷")?.relations).toEqual([]);
    expect(byName.get("温泉")?.relations).toEqual([
      {
        target: "死の谷",
        kind: "within",
        value: null,
        evidence: "「死の谷の奥にあるという温泉の調査のためですの。」",
        chapters: [6],
      },
    ]);
    expect(result.rejected).toEqual([]);
  });

  test("相手の場所が同じ回の答えに無ければ、落として理由を残す（黙って捨てない）", () => {
    const result = validateExtractedLocations([valley([reversedRelation])], chunk);
    expect(result.accepted[0]?.data.relations).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "死の谷の位置関係（温泉）", reason: "reversed_relation" },
    ]);
  });

  test("相手が正しい向きを自分で持っていれば、二重に足さない", () => {
    const result = validateExtractedLocations(
      [
        valley([reversedRelation]),
        spring([{ target: "死の谷", kind: "within", value: null, evidence: "死の谷の奥にあるという温泉" }]),
      ],
      chunk
    );
    const springData = result.accepted.find((entry) => entry.data.name === "温泉")?.data;
    expect(springData?.relations).toHaveLength(1);
  });

  test("正しい向きはそのまま通す（誤検出しない）", () => {
    const result = validateExtractedLocations(
      [
        spring([{ target: "死の谷", kind: "within", value: null, evidence: "死の谷の奥にあるという温泉" }]),
      ],
      chunk
    );
    expect(result.accepted[0]?.data.relations).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });
});
