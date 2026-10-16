import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 校正・メモパネルの［AIに相談］の吹き出し。動きは相談の割当（`features/findingAdvice.ts` の "chat"、2026-10-08 の裁定）で、
 * e2e/memoConsultAssignment.test.ts が相談のモデルへ届くことを見張っている。吹き出しが「推敲」と書くと、
 * 推敲のAIを替えた作者が、相談の答えがどのAIから来たかを取り違える（2026-10-16 に見つけた）
 */
describe("校正・メモパネルの［AIに相談］の吹き出し", () => {
  const source = readFileSync("src/views/sceneMemoPanelHtml.ts", "utf8");

  test("推敲のAIを使うとは書かない", () => {
    expect(source).not.toContain("推敲に割り当てたAIを使います");
  });

  test("相談に割り当てたAIを使うと書く", () => {
    expect(source).toContain("相談に割り当てたAIを使います");
  });
});
