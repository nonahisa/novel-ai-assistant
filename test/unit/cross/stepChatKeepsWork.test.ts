import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findAction } from "../../../src/core/actionTree";

/**
 * 簡単ステップメニューの「AIに相談」が、選んだ作品を捨てていた
 * （使いにくい所の洗い出し2回目の2。作者の判断 2026-11-02）。
 *
 * ステップメニューは作品が要る項目へ選んだ作品（`WorkRef`）を渡すのに、
 * `novelai.openChatPanel` は引数を見ずに大きいパネルを開いていた。相談は
 * 前の作品のまま開き、作者は最上段で選んだ作品とは別の作品について相談する
 * ことになる。**引数が作品なら、相談の作品をそれに合わせてから開く。**
 */
const source = readFileSync(
  resolve(__dirname, "../../../src/extension.ts"),
  "utf8"
);

function commandBody(id: string): string {
  const start = source.indexOf(`registerCommand("${id}"`);
  expect(start, `${id} の登録が見つからない`).toBeGreaterThan(-1);
  const next = source.indexOf("registerCommand(", start + 10);
  return source.slice(start, next);
}

describe("ステップメニューの「AIに相談」は選んだ作品で開く", () => {
  test("ステップメニューは、この項目へ作品を渡している", () => {
    expect(findAction("novelai.openChatPanel")?.requiresWork).toBe(true);
  });

  test("引数の作品が相談の作品と違えば、合わせてから開く", () => {
    const body = commandBody("novelai.openChatPanel");
    expect(body).toMatch(/\(node\?: unknown\)/);
    expect(body).toContain("isWorkRefArg(node)");
    expect(body).toMatch(/currentWorkId\(\) !== node\.work\.id/);
    expect(body).toContain("await workChatPanel.focusWork(node.work)");
    // 合わせたあとで開く（開いてから合わせると、前の作品で一瞬描かれる）
    expect(body.indexOf("focusWork")).toBeLessThan(
      body.indexOf("openLargePanel")
    );
  });
});
