import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { APPLIED_BY_LABELS, appliedByOf } from "../../../src/core/appliedFindings";
import { AUTHOR_EDIT_NOTE } from "../../../src/mcp/tools/outbox";
import { OUTBOX_DECISION_NOTES } from "../../../src/models/finding";

/**
 * 原稿箱の取り込み（`mcp/tools/outbox.ts`、設計書6.115）が判断の行に残す覚え書きと、
 * 提案パネルの「当てたもの」（`core/appliedFindings.ts`）の読み方が噛み合っているか
 * （作者の裁定 2026-10-04）。
 *
 * **2つは別の束に入る**（取り込みは MCP サーバー、当てたものは拡張機能）。覚え書きの
 * 文字列は `models/finding.ts` の `OUTBOX_DECISION_NOTES` に1つだけ置いてあるが、
 * 取り込む側が文字列を直書きに戻すと、「当てたもの」から出先の分が黙って消える
 * ——画面では「並ばない」としか見えない。
 */

const OUTBOX_SOURCE = readFileSync(
  path.join(__dirname, "../../../src/mcp/tools/outbox.ts"),
  "utf8"
);

describe("原稿箱の覚え書きと「当てたもの」", () => {
  test("［直す］は「出先で当てた」、［自分で直す］の作者の文の行は「出先で自分で直した」と読む", () => {
    expect(APPLIED_BY_LABELS[appliedByOf(OUTBOX_DECISION_NOTES.fix)!]).toBe("出先で当てた");
    expect(APPLIED_BY_LABELS[appliedByOf(AUTHOR_EDIT_NOTE)!]).toBe("出先で自分で直した");
  });

  test("本文に修正案が入っていない判断（［済み］・［採らない］・［自分で直す］の元の指摘）は並べない", () => {
    expect(appliedByOf(OUTBOX_DECISION_NOTES.done)).toBeUndefined();
    expect(appliedByOf(OUTBOX_DECISION_NOTES.reject)).toBeUndefined();
    expect(appliedByOf(OUTBOX_DECISION_NOTES.editOriginal)).toBeUndefined();
  });

  test("取り込む側は覚え書きを直書きせず、モデルの定数を使う", () => {
    for (const note of Object.values(OUTBOX_DECISION_NOTES)) {
      expect(OUTBOX_SOURCE, `outbox.ts に「${note}」が直書きされています`).not.toContain(`"${note}"`);
    }
  });
});
