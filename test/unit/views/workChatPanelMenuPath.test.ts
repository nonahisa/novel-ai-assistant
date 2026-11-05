import { describe, expect, test } from "vitest";
import { buildWorkChatPanelHtml } from "../../../src/views/workChatPanelHtml";

/**
 * 「光らせる」札に、メニューの場所の図を添える（設計書6.118。作者の依頼 2026-11-05
 * 「光るのとメニューを開くだけではわかりにくいので、メニュー構造の模式図を出す等」）。
 *
 * 図の文字列は拡張機能の側（`core/menuPath.ts`）で組んで札と一緒に送る。画面は並べるだけ。
 * **WebView は実機でしか動かない**ので、ここで見るのは組み立ての形だけ
 * （`workChatPanelChoices.test.ts` と同じやり方）。
 */

const HTML = buildWorkChatPanelHtml("test-nonce", "vscode-resource:");

/** `function 名前(` から、その関数の閉じ括弧（行頭の `}`）までを切り出す */
function functionBody(name: string): string {
  const start = HTML.indexOf("function " + name + "(");
  expect(start, name + " が見つからない").toBeGreaterThanOrEqual(0);
  const rest = HTML.slice(start);
  return rest.slice(0, rest.indexOf("\n}"));
}

describe("光らせる札の場所の図", () => {
  test("札ごとに、図の箱を添える（図が届いた札だけ）", () => {
    const body = functionBody("appendSpotlight");
    expect(body).toContain("entry.path");
    expect(body).toContain("'menu-path'");
  });

  test("図の文字は escapeHtml を通す（届いた文字を HTML として読まない）", () => {
    const body = functionBody("appendSpotlight");
    expect(body).toContain("escapeHtml(entry.path)");
  });

  test("等幅で、改行と字下げを保ったまま出す（木の形が崩れない）", () => {
    const rule = HTML.slice(HTML.indexOf(".menu-path {"));
    const block = rule.slice(0, rule.indexOf("}"));
    expect(block).toContain("white-space: pre-wrap");
    expect(block).toContain("--vscode-editor-font-family");
  });

  test("図を押しても何も走らない（押せるのは札のボタンだけ）", () => {
    const body = functionBody("appendSpotlight");
    // postMessage は札のボタンの1か所だけ
    expect(body.split("vscode.postMessage").length - 1).toBe(1);
  });
});
