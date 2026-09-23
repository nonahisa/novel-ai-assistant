import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../src/views/writingStatsPanelHtml";
import { describeWrittenAmount } from "../../src/core/writingAmountText";

/**
 * 執筆量パネルの画面（設計書6.3）。
 *
 * ここで見るのは**言い方**だけである。見え方の良し悪しは実機でしか
 * 分からないが、「削った日を負の数のまま見せない」（作者の指定、
 * 2026-09-06）は機械で見張れる。
 *
 * WebViewの中からは `describeWrittenAmount` を呼べない（スクリプトを
 * 文字列として埋め込むため）。**同じ言い方になっていること**を、
 * ここで突き合わせる。
 */

const html = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
const script = (() => {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

describe("執筆量の言い方", () => {
  test("削った日は「削った」と言葉で言う（拡張機能側と同じ）", () => {
    expect(describeWrittenAmount(-12)).toBe("削った 12字");
    expect(script).toContain("'削った ' + formatCount(-value) + '字'");
  });

  test("符号だけで出す関数（signed）は残っていない", () => {
    // 残っていると、直し忘れた場所から「−12字」が出続ける
    expect(script).not.toContain("function signed");
    expect(script).not.toContain("signed(");
  });

  test("合計の行・日別の目盛り・今日のカードが、同じ関数を通る", () => {
    expect(script).toContain("amount(today.progress.written)");
    expect(script).toContain("amount(bucket.net)");
    expect(script).toContain("amount(total)");
  });

  test("スクリプトがJavaScriptとして読める", () => {
    expect(() => new Function(script)).not.toThrow();
  });
});
