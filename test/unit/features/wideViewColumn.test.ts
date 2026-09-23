import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { window } from "../support/vscodeStub";
import { wideViewColumn } from "../../../src/features/editorColumn";

/**
 * 広く見る画面（執筆統計・年表・相関図など）を、本文の列へ開く
 * （作者の裁定「真ん中ですね」、2026-09-23）。
 *
 * 前面の列（`ViewColumn.Active`）に開くと、提案パネルやシーンメモの細い
 * 右の列が前面のときにそこへ開き、表やグラフが詰まった（ノートPCの実機）。
 */
afterEach(() => {
  window.visibleTextEditors = [];
});

describe("広く見る画面を開く列", () => {
  test("見えている本文のうち、いちばん左の列", () => {
    window.visibleTextEditors = [{ viewColumn: 3 }, { viewColumn: 2 }];
    expect(wideViewColumn()).toBe(2);
  });

  test("本文が見えていなければ1列目", () => {
    window.visibleTextEditors = [];
    expect(wideViewColumn()).toBe(1);
  });

  test("列の分からないエディターは数えない", () => {
    window.visibleTextEditors = [{}, { viewColumn: 2 }];
    expect(wideViewColumn()).toBe(2);
  });
});

describe("広く見る画面は、前面の列に開かない", () => {
  const WIDE_PANELS = [
    "writingStatsPanel.ts",
    "allWorksWritingStatsPanel.ts",
    "chroniclePanel.ts",
    "editHistoryPanel.ts",
    "epubEditorPanel.ts",
    "nameCheck.ts",
    "relationGraphPanel.ts",
    "workChatPanel.ts",
  ];
  test.each(WIDE_PANELS)("%s", (file) => {
    const source = readFileSync(
      resolve(__dirname, "../../../src/features", file),
      "utf8"
    );
    expect(source).not.toContain("vscode.ViewColumn.Active,");
    expect(source).toContain("wideViewColumn()");
  });
});
