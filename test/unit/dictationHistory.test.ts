import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 口述筆記の整文は、本文をその場で書き換える経路のうち**唯一、編集履歴を
 * 残していなかった**（実機確認 A-19 の棚卸し、2026-09-06）。書き換えたのが
 * 誰か分からない状態は「作者の原稿を壊さない」の土台が抜けている。
 * 適用に成功したら `recordEdit` を通すことを、源の形で見張る。
 */
const source = readFileSync(
  resolve(__dirname, "../../src/features/dictationClean.ts"),
  "utf8"
);

describe("口述筆記の整文の履歴", () => {
  test("適用に成功したら編集履歴を残す", () => {
    const applied = source.indexOf("const applied = await applyDictationText(");
    const record = source.indexOf("recordEdit(work, {", applied);
    expect(applied).toBeGreaterThan(0);
    expect(record).toBeGreaterThan(applied);
    expect(source.slice(record, record + 400)).toContain("口述筆記の整文を反映した");
  });
});
