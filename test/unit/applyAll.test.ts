import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 「まとめて適用」（2026-08-19、作者が実機で発見）。
 *
 * **押しても何も起きなかった。** 原因は2つ。
 *
 * 1. **0件のとき黙って戻っていた。** 推敲は修正案の無い指摘が9割なので、
 *    対象が0件になる。押したのに無反応だと「壊れている」としか見えない
 * 2. **設定資料の更新の一覧では、本文の指摘しか見ていなかった。**
 *    ボタンは出るのに、押しても対象が空だった
 *
 * WebViewを要するため、ここでは**その道が残っているか**を見る。
 */
const panel = () => readFileSync("src/features/proposalPanel.ts", "utf-8");
const html = () => readFileSync("src/views/proposalPanelHtml.ts", "utf-8");

describe("0件でも黙らない", () => {
  test("理由を伝える道がある", () => {
    expect(panel()).toContain("describeNoTarget");
  });

  test("**修正案が無い**ことを理由として言う", () => {
    // 「ありません」だけでは、作者は何をすればよいか分からない
    expect(panel()).toContain("修正案がありません");
  });

  test("確信度が低いことも理由として言う", () => {
    expect(panel()).toContain("確信度が「低」");
  });

  test("黙って戻る道が消えている", () => {
    // 以前は `if (targets.length === 0) return;` だった
    expect(panel()).not.toMatch(/targets\.length === 0\)\s*return;/u);
  });
});

describe("設定資料の更新も、まとめて反映できる", () => {
  test("更新の一覧を見る道がある", () => {
    expect(panel()).toContain("applyAllRecordUpdates");
  });

  test("本文の指摘より先に、更新を見る", () => {
    // 更新の一覧では this.items が空なので、先に分岐しないと0件になる
    const source = panel();
    const branch = source.indexOf("this.recordUpdates.length > 0");
    const items = source.indexOf("const pending = this.items.filter");

    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(items);
  });

  test("**作者が確定させた記述が書き換わる**ことを伝える", () => {
    expect(panel()).toContain("作者が確定させた記述が書き換わります");
  });
});

describe("終わったことを伝える", () => {
  test("何件入ったかを出す", () => {
    // 何件入って何件入らなかったか分からないと、一覧を数え直すことになる
    expect(panel()).toContain("件を適用しました");
  });
});

describe("ボタンの名前", () => {
  test("「表示中」と言わない", () => {
    // **嘘だった。** 確信度が低いものは、表示していても対象外である
    expect(html()).not.toContain("表示中をまとめて適用");
  });

  test("何が対象かを、ホバーで伝える", () => {
    expect(html()).toContain("確信度が「高」「中」で、修正案のあるものだけ");
  });
});
