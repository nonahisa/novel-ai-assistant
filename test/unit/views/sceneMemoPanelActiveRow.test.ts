import { describe, expect, test } from "vitest";
import { buildSceneMemoPanelHtml } from "../../../src/views/sceneMemoPanelHtml";

/**
 * 校正・メモパネルで押した行の光りを、原稿エディターの飛んだ行の光り
 * （`.mark-reveal` / `novelai-reveal`）と同じ色の決め方にそろえる
 * （作者の裁定、2026-10-10）。
 *
 * 以前はリストの選択色（list-activeSelectionBackground）を使っており、暗い
 * テーマで灰色の帯に見えた。左の原稿は青い枠で光るので、2つの光りが
 * 同じ場所だと結びつかなかった。どちらも VS Code の focusBorder から決める。
 */
const html = buildSceneMemoPanelHtml("N", "vscode-resource:");
const style = html.match(/<style nonce="N">([\s\S]*?)<\/style>/)![1];

/** `.memo.active {` の規則の中身 */
function activeRule(): string {
  const found = style.match(/\.memo\.active\s*\{([^}]*)\}/);
  if (!found) throw new Error(".memo.active の規則が見つからない");
  return found[1];
}

describe("押した行の光り", () => {
  test("原稿エディターと同じ focusBorder から、背景と枠を決める", () => {
    const rule = activeRule();
    expect(rule).toContain("var(--vscode-focusBorder");
    expect(rule).toContain("color-mix(in srgb, var(--vscode-focusBorder");
    expect(rule).toMatch(/outline:\s*2px solid var\(--vscode-focusBorder/);
  });

  test("リストの選択色（暗いテーマで灰色になる）は使わない", () => {
    expect(style).not.toContain("list-activeSelectionBackground");
    expect(style).not.toContain("list-activeSelectionForeground");
  });
});
