import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 人物を分ける確認の窓の文。分けると人物の顔ぶれが変わり、次の抽出は全部の話をAIへ送り直す
 * （`characterExtractCastKey.test.ts`「作者が手で足した人物がいれば、全部読み直す」）。
 * 窓が「AIは呼ばれません」と約束すると、クラウドのAIでは料金がかかるのに無料だと読める（2026-10-16 の仕分けで見つけた）
 */
describe("人物を分ける確認の窓", () => {
  const source = readFileSync("src/features/settingsPanel.ts", "utf8");

  test("次の抽出でAIが呼ばれないとは約束しない", () => {
    expect(source).not.toContain("AIは呼ばれません");
  });

  test("次の抽出は全部の話を送り直すことと、送る量が実行前の確認に出ることを書く", () => {
    expect(source).toContain("次の抽出では全部の話をAIへ送り直します");
  });
});
