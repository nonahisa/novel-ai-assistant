import { describe, expect, test } from "vitest";
import { buildProposalPanelHtml } from "../../src/views/proposalPanelHtml";

/**
 * 提案パネルのボタン列（作者の指摘、2026-09-06）。
 *
 * 「適用／無視／今後直さない／再チェック／戻す」が小さく詰まっており、
 * 押し間違えやすい。**「今後直さない」だけは離す**——その語を今後どの話でも
 * 指摘しなくなる、取り消しにくい判断だからである。
 *
 * 見た目の良し悪しは実機でしか分からないので、ここで見るのは
 * 「約束（大きさ・間隔・離すこと）がCSSに入っているか」だけである。
 */

const html = buildProposalPanelHtml("NONCE123", "vscode-resource:");
const style = (() => {
  const found = html.match(/<style nonce="NONCE123">([\s\S]*?)<\/style>/);
  if (!found) throw new Error("スタイルが見つかりません");
  return found[1];
})();

describe("ボタンは押しやすい大きさにする", () => {
  test("高さと横の余白を確保する", () => {
    expect(style).toContain("padding: 4px 10px");
    expect(style).toContain("min-height: 28px");
  });

  test("ボタンどうしの間隔を広げる", () => {
    expect(style).toContain(".actions { display: flex; gap: 8px;");
  });
});

describe("「今後直さない」は離す", () => {
  test("その語に専用の印（class）を付ける", () => {
    expect(html).toContain("secondary keep-word");
  });

  test("左に余白を足して、隣のボタンから離す", () => {
    expect(style).toContain(".actions .keep-word { margin-inline-start: 16px; }");
  });
});
