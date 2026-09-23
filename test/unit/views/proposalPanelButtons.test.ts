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

/**
 * 説明が長くても、ボタン列を枠の中に残す（作者の指摘、2026-09-06）。
 *
 * 矛盾は「設定では／本文では」の対比に加えて4行の説明が付くので、
 * 既定の高さの提案パネルでは**1件だけでも**
 * 「本文を見る／設定資料を見る／無視／伏線として登録／再チェック」が
 * 下へはみ出し、初見では「ボタンが無い」に見えた。
 *
 * 説明を畳むのではなく（読まずに押されると困る）、説明の塊だけを
 * スクロールさせる。ボタン列はその塊の外にあるので、常に見えている。
 */
describe("矛盾の説明が長くても、ボタンが見える", () => {
  test("説明はひと塊にまとめて、そこだけスクロールさせる", () => {
    expect(style).toContain(".contradiction .details {");
    expect(style).toContain("overflow-y: auto;");
    expect(style).toContain("max-height: 40vh;");
  });

  test("説明の塊が、ボタン列より前にある", () => {
    const render = html.slice(html.indexOf("function renderContradiction"));
    const body = render.slice(0, render.indexOf("\nfunction "));
    expect(body).toContain("'<div class=\"details\">'");
    expect(body.indexOf('class="details"')).toBeLessThan(
      body.indexOf('class="actions"')
    );
  });

  test("ボタン列は折り返し、押し出されて縮まない", () => {
    expect(style).toContain("flex-wrap: wrap;");
    expect(style).toContain(".issue .actions { flex-shrink: 0; }");
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
