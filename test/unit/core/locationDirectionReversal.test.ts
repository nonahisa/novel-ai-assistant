import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { directionFromQuote } from "../../../src/core/locationWithinDirection";
import { validateExtractedLocations } from "../../../src/core/settingsExtractionValidation";

/**
 * 場所の位置関係の向きを、根拠の本文の語順・助詞で確かめる（作者の裁定 2026-10-17
 * 「検算で照らす」。A18）。
 *
 * 「中にある」（within）は 2026-10-15 の裁定7で確かめている
 * （`locationWithinDirection.test.ts`）。**方角（direction）も同じ形で逆になりうる**
 * ——「港の北に学校がある」から「港は学校の北」と読めば、関係は向きごと逆になる。
 * 方角も向きのある関係なので、同じ見方で確かめる。見逃しと誤検出の両方を見る。
 */

describe("引用の形から方角の向きを読む", () => {
  test.each([
    ["学校は港の北に建っている", "学校", "港", "北"],
    ["港の北に学校がある", "学校", "港", "北"],
    ["港の北の学校", "学校", "港", "北"],
    ["王都の南東にあるという砦", "砦", "王都", "南東"],
    ["村は川の西側にある", "村", "川", "西"],
  ])("正しい向き：%s（%s は %s の %s）", (quote, self, target, value) => {
    expect(directionFromQuote(quote, [self], [target], value)).toBe("consistent");
  });

  test.each([
    ["学校は港の北に建っている", "港", "学校", "北"],
    ["港の北に学校がある", "港", "学校", "北"],
    ["港の北の学校", "港", "学校", "北"],
    ["王都の南東にあるという砦", "王都", "砦", "南東"],
  ])("逆向き：%s（%s を %s の %s と読んだ）", (quote, self, target, value) => {
    expect(directionFromQuote(quote, [self], [target], value)).toBe("reversed");
  });

  test.each([
    // 方角の語が値と違う
    ["学校は港の北に建っている", "学校", "港", "南"],
    // 「から」で始まる道のり（向きの読み方が決まらない）
    ["港から北へ三日歩くと学校に着く", "学校", "港", "北"],
    // 相手の名前が無い
    ["北に学校がある", "学校", "港", "北"],
  ])("形から読めないものには触らない：%s", (quote, self, target, value) => {
    expect(directionFromQuote(quote, [self], [target], value)).toBe("unknown");
  });
});

describe("検算：逆向きの方角は相手の場所へ付け替える", () => {
  const chunk: Chunk = {
    filePath: "003.txt",
    index: 0,
    text: "学校は港の北に建っている。\n港には船が並んでいた。",
    startLine: 0,
    hash: "fixture",
    chapterStart: 3,
    chapterEnd: 3,
  };
  const port = (relations: unknown[]) => ({
    name: "港",
    evidence: "港には船が並んでいた",
    relations,
  });
  const school = (relations: unknown[] = []) => ({
    name: "学校",
    evidence: "学校は港の北に建っている",
    relations,
  });
  const reversedRelation = {
    target: "学校",
    kind: "direction",
    value: "北",
    evidence: "学校は港の北に建っている",
  };

  test("「港 は 学校 の北」は「学校 は 港 の北」になる", () => {
    const result = validateExtractedLocations([port([reversedRelation]), school()], chunk);
    const byName = new Map(result.accepted.map((entry) => [entry.data.name, entry.data]));
    expect(byName.get("港")?.relations).toEqual([]);
    expect(byName.get("学校")?.relations).toEqual([
      {
        target: "港",
        kind: "direction",
        value: "北",
        evidence: "学校は港の北に建っている",
        chapters: [3],
      },
    ]);
    expect(result.rejected).toEqual([]);
  });

  test("相手の場所が同じ回の答えに無ければ、落として理由を残す", () => {
    const result = validateExtractedLocations([port([reversedRelation])], chunk);
    expect(result.accepted[0]?.data.relations).toEqual([]);
    expect(result.rejected).toEqual([{ name: "港の位置関係（学校）", reason: "reversed_relation" }]);
  });

  test("正しい向きはそのまま通す", () => {
    const result = validateExtractedLocations(
      [school([{ target: "港", kind: "direction", value: "北", evidence: "学校は港の北に建っている" }])],
      chunk
    );
    expect(result.accepted[0]?.data.relations).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  test("相手が正しい向きを自分で持っていれば、二重に足さない", () => {
    const result = validateExtractedLocations(
      [
        port([reversedRelation]),
        school([{ target: "港", kind: "direction", value: "北", evidence: "学校は港の北に建っている" }]),
      ],
      chunk
    );
    const data = result.accepted.find((entry) => entry.data.name === "学校")?.data;
    expect(data?.relations).toHaveLength(1);
  });
});
