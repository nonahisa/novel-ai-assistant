import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eolLabel } from "../../src/core/eolAudit";

/**
 * 改行コードを揃える操作は、**ファイルの全行を書き換える**。
 *
 * 残していないと、あとで差分を見た人（編集部・別の環境の自分）が
 * 「全行が変わっているが、誰が何をしたのか分からない」ことになる。
 * これは実機確認 A-19 の棚卸し（2026-09-06）で問われた
 * 「本文を書き換える経路のうち、編集履歴を残さないものが無いか」に当たる。
 *
 * 0.47.8 で改行を揃える操作を入れたときに**残していなかった**
 * （引継ぎ書の積み残し⑧）。0.50.6 で、口述筆記の整文
 * （`dictationClean.ts`、0.40.8）と同じ形にそろえた。
 */
const source = readFileSync(
  resolve(__dirname, "../../src/features/eolUnify.ts"),
  "utf8"
);

describe("改行コードを揃えたら、編集履歴に残す", () => {
  test("書き込みが通ったときだけ残す", () => {
    const wrote = source.indexOf("const result = await writeTextFilePreservingFormat(");
    const ok = source.indexOf("if (result.ok) {", wrote);
    const record = source.indexOf("recordEdit(work, {", ok);
    expect(wrote).toBeGreaterThan(0);
    expect(ok).toBeGreaterThan(wrote);
    expect(record).toBeGreaterThan(ok);
    // **失敗した側に紛れ込んでいないこと。** 書けていないのに
    // 「揃えた」と残すと、履歴のほうが嘘になる
    const failed = source.indexOf("failed.push({ filePath, reason: describeWriteFailure", ok);
    expect(record).toBeLessThan(failed);
  });

  test("**1件ずつ残す**（どのファイルを触ったかが読める）", () => {
    const record = source.indexOf("recordEdit(work, {");
    const block = source.slice(record, record + 500);
    expect(block).toContain("改行コードを揃えた");
    expect(block).toContain("file: path.basename(filePath)");
  });

  test("残すのは「元 → 先」で、元は変換前の値", () => {
    const record = source.indexOf("recordEdit(work, {");
    const block = source.slice(record, record + 500);
    // `plan.format.eol` は揃えたあとの値。使うと「LF → LF」になる
    expect(block).not.toContain("plan.format.eol");
    expect(block).toContain("content.eol");
    expect(block).toContain("content.hasMixedEol");
  });
});

describe("改行コードの呼び名", () => {
  test("揃え先の2つ", () => {
    expect(eolLabel("\n")).toBe("LF");
    expect(eolLabel("\r\n")).toBe("CRLF");
  });

  test("**CR も言える**（揃え元には古い Mac の CR が来る）", () => {
    // 「CR → LF」と残せないと、履歴が「LF → LF」になって意味を成さない
    expect(eolLabel("\r")).toBe("CR");
  });
});
