import { describe, expect, test } from "vitest";
import { extractSettingsHint } from "../../../src/features/checkContradictions";
import { findAction } from "../../../src/core/actionTree";

/**
 * 設定資料が無いときの矛盾検知の案内は、メニューにある名前を言う（作者の判断 2026-11-01）。
 *
 * 「設定資料をまとめて抽出」と書いていたが、メニューの名前は「一括抽出」で、
 * 作者がその名前で探しても見つからなかった。
 */
describe("矛盾検知の、設定資料が無いときの次の一手", () => {
  test("詳細メニューの項目名（一括抽出）を言う", () => {
    const label = findAction("novelai.extractSettings")?.label;
    expect(label).toBe("一括抽出");
    expect(extractSettingsHint()).toContain(`「${label}」`);
    expect(extractSettingsHint()).not.toContain("まとめて抽出");
  });
});
