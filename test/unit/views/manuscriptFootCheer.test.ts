import { describe, expect, test } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 原稿エディターの下の欄の「目標に届きました」（設計書6.3.8）。
 *
 * **書いている最中の画面には何も飛ばさない**のが作者の裁定である。
 * 下の欄（字数の隣）に一言添えるだけで、風船も札も出さない。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const script = (() => {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

describe("下の欄の一言", () => {
  test("字数と同じ下の欄に置く", () => {
    const foot = html.slice(html.indexOf('<div id="foot">'), html.indexOf("</div>", html.indexOf('<div id="foot">')));
    expect(foot).toContain('<span id="counts"></span>');
    expect(foot).toContain('<span id="cheer"></span>');
  });

  test("字数と一緒に届いた一言を出し、無ければ消す", () => {
    expect(script).toContain('document.getElementById("cheer")');
    expect(script).toContain('typeof message.cheer === "string" ? message.cheer : ""');
  });

  test("原稿エディターでは風船も花火も描かない", () => {
    // （Canvas は字幅を測るのに前から使っているので、ここでは見ない）
    expect(script).not.toContain("celebrate");
    expect(script).not.toContain("requestAnimationFrame(frame)");
  });
});
