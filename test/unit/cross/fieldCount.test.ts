import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { countField, formatCount, readMarker } from "../../../scripts/fieldCount.mjs";

/*
  実機確認の数と、済みの記録の写しを見張る（2026-10-17）。

  済みの項目は引継ぎ書2章へ写して一覧から消す。消した数は一覧の冒頭の印
  `field-moved-done` に置き、`scripts/fieldCount.mjs` がそれを済みに足す。
  印と写しが食い違うと、進捗率が黙ってずれる（写し忘れ・二重に足す）。
  一覧と引継ぎ書の両方を読むので cross に置く。
*/

const LIST = "docs/実機確認リスト.md";
const HANDOVER = "docs/進捗と引継ぎ.md";
const START = "<!-- field-moved-done-section: start -->";
const END = "<!-- field-moved-done-section: end -->";

const list = readFileSync(LIST, "utf-8");
const handover = readFileSync(HANDOVER, "utf-8");

function countLines(text: string, pattern: RegExp): number {
  return text.split(/\r?\n/).filter((l) => pattern.test(l)).length;
}

describe("実機確認リストと引継ぎ書2章の写し", () => {
  test("一覧の冒頭に、移した数の印が2つある", () => {
    expect(readMarker(list, "field-moved-done")).not.toBeNull();
    expect(readMarker(list, "field-moved-done-earlier")).not.toBeNull();
  });

  test("移した数の印と、引継ぎ書2章へ写した `- [x]` の数が一致する", () => {
    const s = handover.indexOf(START);
    const e = handover.indexOf(END);
    expect(s, "引継ぎ書に写しの節の始まりの印がありません").toBeGreaterThanOrEqual(0);
    expect(e, "写しの節の終わりの印が始まりより前か、ありません").toBeGreaterThan(s);
    // 写しの節は2章の中（8章より前）に置く
    const journal = handover.search(/^## 8\. 作業の記録/m);
    expect(e).toBeLessThan(journal);

    const copied = countLines(handover.slice(s, e), /^\s*- \[[xX]\]/);
    expect(copied).toBe(readMarker(list, "field-moved-done"));
  });

  test("写しの節の中に未済（`- [ ]`）が混ざっていない", () => {
    const section = handover.slice(handover.indexOf(START), handover.indexOf(END));
    expect(countLines(section, /^\s*- \[ \]/)).toBe(0);
  });
});

describe("fieldCount", () => {
  test("今のファイルで数えられ、残数が一覧の `- [ ]` の数と一致する", () => {
    const c = countField(list);
    expect(c.remaining).toBe(countLines(list, /^\s*- \[ \]/));
    expect(c.doneInList).toBe(countLines(list, /^\s*- \[[xX]\]/));
    expect(c.done).toBe(c.doneInList + c.movedNow + c.movedEarlier);
    expect(c.total).toBe(c.done + c.remaining);
    expect(c.rate).toBeGreaterThan(0);
    expect(c.rate).toBeLessThanOrEqual(100);
  });

  test("〔保留〕の行は残りにも済みにも入らない", () => {
    const text = [
      "<!-- field-moved-done: 3 -->",
      "<!-- field-moved-done-earlier: 1 -->",
      "- [ ] 未済",
      "  - [ ] 子の未済",
      "- [x] 済み",
      "- 〔保留〕 ChatGPT",
    ].join("\n");
    const c = countField(text);
    expect(c.remaining).toBe(2);
    expect(c.done).toBe(1 + 3 + 1);
    expect(c.total).toBe(7);
    expect(c.doneWithoutEarlier).toBe(4);
    expect(c.totalWithoutEarlier).toBe(6);
  });

  test("印が無ければ止まる（0件として数えて率を水増ししない）", () => {
    expect(() => countField("- [ ] 未済")).toThrow(/field-moved-done/);
  });

  test("日本語の3行で出す", () => {
    const out = formatCount(countField(list));
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^実機確認：残り [\d,]+件／済み [\d,]+件／全体 [\d,]+件（進捗率 \d+\.\d{2}%）$/);
  });
});
