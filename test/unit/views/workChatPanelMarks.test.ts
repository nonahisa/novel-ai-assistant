import { describe, expect, test } from "vitest";
import { buildWorkChatPanelHtml } from "../../src/views/workChatPanelHtml";

/**
 * **番号の枠を記号に流用しない**（作者の指摘、2026-09-07
 * 「その後の選択肢も、触ってみましたが混乱していてわかりません」）。
 *
 * 選択肢の番号（1・2・3）を出す `.num` へ「↻」「▶」「◎」「✓」を入れていた
 * ため、幅の決まった小さな枠に押し込まれて**「ひ」のように潰れて見えた**。
 * 記号は `.mark` に分け、環境で潰れやすい「↻」は漢字の「再」にする。
 */
describe("選択肢の記号", () => {
  const HTML = buildWorkChatPanelHtml("test-nonce", "vscode-resource:");

  test("番号の枠に記号を入れていない", () => {
    for (const mark of ["↻", "▶", "◎", "✓"]) {
      expect(HTML, mark).not.toContain(`class="num">${mark}`);
    }
  });

  test("記号には専用の見た目を与えている（幅を決めない）", () => {
    expect(HTML).toContain(".option .mark");
    // 数字揃えは番号のためのもの。記号に掛けると幅が固定されて潰れる
    const markRule = HTML.slice(HTML.indexOf(".option .mark"));
    expect(markRule.slice(0, markRule.indexOf("}"))).not.toContain(
      "font-variant-numeric"
    );
  });

  test("再読込は「再」で出す（矢印の記号は環境で潰れる）", () => {
    expect(HTML).toContain('<span class="mark">再</span>');
    // 由来の説明（コメント）には残っていてよい。ボタンに出さないことが要点
    expect(HTML).not.toMatch(/<span class="(num|mark)">↻/);
  });

  test("番号はこれまでどおり `.num` で出す", () => {
    expect(HTML).toContain(`'<span class="num">' + (index + 1) + '</span>'`);
  });
});
