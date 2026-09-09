import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 詳細メニューは、1項目で例外が出てもメニュー全体を欠けさせない
 * （実機確認 A-21：作品を11件登録した直後に4グループと3項目が消えた。
 * 2026-09-08）。項目ごとに捕まえてログに残し、その項目は素の表示で出す。
 */
const source = readFileSync(
  resolve(__dirname, "../../src/views/actionList.ts"),
  "utf8"
);

describe("詳細メニューの保険", () => {
  test("getTreeItem と getChildren は例外を捕まえてログに残す", () => {
    expect(source).toMatch(/getTreeItem\(node: ActionNode\): vscode\.TreeItem \{\s*try \{\s*return this\.buildTreeItem\(node\);/);
    expect(source).toMatch(/getChildren\(node\?: ActionNode\): ActionNode\[\] \{\s*try \{\s*return this\.listChildren\(node\);/);
    expect(source).toContain('logFailure("詳細メニューの項目"');
    expect(source).toContain('logFailure("詳細メニューの中身"');
  });
});
