import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 執筆統計の風船と花火（設計書6.3.8）。
 *
 * 見え方の良し悪しは実機でしか分からない。ここで見張るのは、
 * 作者の裁定のうち**機械で確かめられる線**だけである。
 *
 * - 画面の操作を妨げない（重ねる層は pointer-events: none）
 * - 動きを減らす設定では動かさない
 * - 外部のライブラリを読まない（CSP を緩めない）
 * - 見せ終えたら拡張機能へ返す（二度は上げない）
 */

const html = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
const script = (() => {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();
const style = (() => {
  const found = html.match(/<style nonce="NONCE123">([\s\S]*?)<\/style>/);
  if (!found) throw new Error("スタイルが見つかりません");
  return found[1];
})();

function rule(selector: string): string {
  const start = style.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} の指定がありません`);
  return style.slice(start, style.indexOf("}", start));
}

describe("風船と花火", () => {
  test("重ねる層と札は、下の操作を妨げない", () => {
    expect(rule(".celebrate-layer")).toContain("pointer-events: none");
    expect(rule(".celebrate-banner")).toContain("pointer-events: none");
  });

  test("動きを減らす設定では、風船を描かず札（達成の印）だけ出す", () => {
    expect(script).toContain("prefers-reduced-motion: reduce");
    expect(script).toContain("if (!reducedMotion()) runCelebration(payload.size);");
    expect(style).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("外部のライブラリを読まない（CSP は nonce のまま）", () => {
    expect(html).toContain("script-src 'nonce-NONCE123';");
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  test("数秒で消える", () => {
    expect(script).toMatch(/const CELEBRATION_MS = \d{4};/);
    expect(script).toContain("canvas.remove()");
    expect(script).toContain("banner.remove()");
  });

  test("見せ終えたら拡張機能へ返し、同じ祝いは二度上げない", () => {
    expect(script).toContain("vscode.postMessage({ type: 'celebrated', ids: payload.ids })");
    expect(script).toContain("playedCelebrations");
  });

  test("1日は少なめの風船、作品・締切では花火も", () => {
    expect(script).toContain("size === 'small' ? 5 : 12");
    expect(script).toContain("if (size === 'fireworks')");
  });

  test("拡張機能から届いた祝いを受け取る", () => {
    expect(script).toContain("message.type === 'celebrate'");
  });
});

describe("達成の記録", () => {
  test("統計が届くたびに達成の印を描き直す", () => {
    expect(html).toContain('<div id="achievements"></div>');
    expect(script).toContain("renderAchievements();");
  });

  test("スクリプトがJavaScriptとして読める", () => {
    expect(() => new Function(script)).not.toThrow();
  });
});
