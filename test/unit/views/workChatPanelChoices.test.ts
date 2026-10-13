import { describe, expect, test } from "vitest";
import { buildWorkChatPanelHtml } from "../../../src/views/workChatPanelHtml";

/**
 * 選択肢を押しても、ほかの種類のボタンの行は消さない（実機確認リスト
 * 【不具合】、2026-10-13。画面テストの束 E18 を書いた担当が見つけた）。
 *
 * 選択肢の行と、［取り消す］・実行・［そこを見せて］・再読込・光らせる・
 * 案内の誘い・直し方の札の行は、同じ `options` の入れ物（見た目の並べ方）を
 * 使っている。送るときに `.options` を全部消していたため、選択肢を1つ押すと、
 * 前の答えに付いていた**まだ押していない**ボタンまで消えていた。
 *
 * 消すのは**選択肢の並び**（`choices` の印を持つ行）だけにする。前の答えの
 * 古い選択肢は今までどおり消す——残すと、どの返事に対する選択なのか
 * 分からなくなる（番号で選ぶ口も、最後の答えの選択肢だけを指す）。
 *
 * **WebView は実機でしか動かない**ので、ここで見るのは組み立ての形だけ。
 * 押して残ることは画面の自動テスト `e2e/chatAnswerButtonsLarge.test.ts` が見る。
 */

const HTML = buildWorkChatPanelHtml("test-nonce", "vscode-resource:");

/** `function 名前(` から、その関数の閉じ括弧（行頭の `}`）までを切り出す */
function functionBody(name: string): string {
  const start = HTML.indexOf("function " + name + "(");
  expect(start, name + " が見つからない").toBeGreaterThanOrEqual(0);
  const rest = HTML.slice(start);
  return rest.slice(0, rest.indexOf("\n}"));
}

describe("選択肢を使ったときに消すもの", () => {
  test("選択肢の並びには、ほかのボタンの行と見分ける印が付く", () => {
    const body = functionBody("appendOptions");
    expect(body).toContain("box.className = 'options choices';");
  });

  test("ほかの種類のボタンの行には、選択肢の印を付けない", () => {
    for (const name of [
      "appendErrorActions",
      "appendEditDone",
      "appendRun",
      "appendReload",
      "appendSpotlight",
      "appendLocate",
      "appendTourOffer",
    ]) {
      expect(functionBody(name), name).not.toContain("choices");
    }
  });

  test("送るときに消すのは選択肢の並びだけ（ほかのボタンの行を巻き込まない）", () => {
    const body = functionBody("send");
    expect(body).not.toContain("querySelectorAll('.options')");
    expect(body).toContain("querySelectorAll('.options.choices')");
  });

  test("別の画面で送られた問いを積むときも、消すのは選択肢の並びだけ", () => {
    const body = functionBody("showAsked");
    expect(body).not.toContain("querySelectorAll('.options')");
    expect(body).toContain("querySelectorAll('.options.choices')");
  });
});
