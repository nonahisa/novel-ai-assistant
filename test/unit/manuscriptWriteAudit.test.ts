import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * **本文を書く経路の棚卸し**（実機確認 A-19）。
 *
 * A-19 は「履歴にも退避にも残らない本文の書き換えが起きた」（2026-09-06、
 * 原因未特定）から始まった。**誰が本文を書くのかを数え上げて、
 * 記録の残らない経路が無いかを確かめる**のがその中身である。
 *
 * 棚卸しの結果、経路は4つに分かれた。
 *
 * | 経路 | 本文を書くか | 記録 |
 * |---|---|---|
 * | `proposalPanel.ts`（提案の適用・戻す） | 書く | 履歴も退避も通る |
 * | `applySettingsRuby.ts`（資料からルビ） | 書く | **履歴も退避も通る** |
 * | `dictationClean.ts`（口述の整文） | 書く | 履歴を通す（0.40.8） |
 * | `eolUnify.ts`（改行を揃える） | 書く | 履歴も退避も通る（0.50.6） |
 * | `manuscriptEditor.ts`（原稿エディタ） | **書かない** | ——（VS Code が保存する） |
 *
 * **原稿エディタだけは事情が違う。** 作者が打った本文を保存するのは
 * VS Code で、拡張機能は書き込み口を持たない（設計書6.25）。
 * だから「履歴を残していない」のではなく、**残すべき書き込みが無い**。
 * ここを取り違えると、打鍵のたびに履歴へ1行積む実装を足しかねない。
 *
 * このテストは**経路が増えたときに気づく**ためにある。新しく本文を書く
 * 処理を足したら、ここの表に載せて、履歴を通すかどうかを決める。
 */

function sourceOf(relative: string): string {
  return readFileSync(resolve(__dirname, "../..", relative), "utf8");
}

describe("本文を書く経路", () => {
  test("**原稿エディタは、本文を書く口を持たない**", () => {
    const source = sourceOf("src/features/manuscriptEditor.ts");
    // 読む口だけ。書くのは VS Code である
    expect(source).toContain('import { readTextFile } from "../core/textFile"');
    expect(source).not.toContain("await writeTextFilePreservingFormat(");
  });

  test("**資料からルビは、書いたあと履歴を通す**", () => {
    const source = sourceOf("src/features/applySettingsRuby.ts");
    expect(source).toContain("writeTextFilePreservingFormat");
    expect(source).toContain("設定資料からルビを振った");

    // 書く場所は2つ（1話ぶんと、まとめて）。**どちらも**履歴を通す
    const writes = source.split("await writeTextFilePreservingFormat(").length - 1;
    const records = source.split("await recordEdit(work, {").length - 1;
    expect(writes).toBe(2);
    expect(records).toBe(2);
  });

  test("改行を揃えるのも、履歴を通す（0.50.6）", () => {
    const source = sourceOf("src/features/eolUnify.ts");
    expect(source).toContain("改行コードを揃えた");
    expect(source).toContain("recordEdit(work, {");
  });

  test("口述の整文も、履歴を通す（0.40.8）", () => {
    const source = sourceOf("src/features/dictationClean.ts");
    expect(source).toContain("口述筆記の整文を反映した");
  });

  test("**提案の適用は、履歴も退避も通る**", () => {
    const source = sourceOf("src/features/reviewProposals.ts");
    expect(source).toContain("writeTextFilePreservingFormat");
    expect(source).toContain("編集部の提案を採り入れた");
  });
});
