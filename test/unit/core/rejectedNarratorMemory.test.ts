import { describe, expect, test } from "vitest";
import type { RejectedCharacterCandidate } from "../../../src/core/characterExtractionValidation";
import {
  describeRejectedNarrators,
  describeRejectedNarratorsForLog,
  parseNotifiedNarrators,
  selectNewNarratorNames,
} from "../../../src/core/rejectedNarratorNotice";

/** 語り手を捨てた断りは、同じ呼び名なら2回目から画面に出さない（作者の裁定、2026-10-01） */

const rejected: RejectedCharacterCandidate[] = [
  { name: "僕", reason: "pronoun_name", details: { role: "主人公" } },
  { name: "語り手", reason: "descriptive_name" },
  { name: "谷村", reason: "ungrounded" },
];

describe("語り手の断りを一度出したら覚える", () => {
  test("まだ覚えていない呼び名だけが新しい", () => {
    expect(selectNewNarratorNames(rejected, new Set())).toEqual(["僕", "語り手"]);
    expect(selectNewNarratorNames(rejected, new Set(["僕"]))).toEqual(["語り手"]);
    expect(selectNewNarratorNames(rejected, new Set(["僕", "語り手"]))).toEqual([]);
  });

  test("覚えた呼び名は画面の断りから外れ、全部覚えていれば何も出ない", () => {
    const text = describeRejectedNarrators(rejected, new Set(["僕"]));
    expect(text).toContain("を1件、");
    expect(text).toContain("「語り手」");
    expect(text).not.toContain("「僕」");
    expect(describeRejectedNarrators(rejected, new Set(["僕", "語り手"]))).toBe("");
  });

  test("操作ログには、覚えていても毎回全件が残る", () => {
    const log = describeRejectedNarratorsForLog(rejected);
    expect(log).toContain("2件");
    expect(log).toContain("「僕」");
  });

  test("覚書の読み込みは壊れていても空として扱う", () => {
    expect([...parseNotifiedNarrators({ names: ["僕", 3, ""] })]).toEqual(["僕"]);
    expect(parseNotifiedNarrators(null).size).toBe(0);
    expect(parseNotifiedNarrators("x").size).toBe(0);
    expect(parseNotifiedNarrators({}).size).toBe(0);
  });
});
