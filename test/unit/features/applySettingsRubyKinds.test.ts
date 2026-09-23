import { describe, expect, test } from "vitest";
import { countReadable } from "../../src/features/applySettingsRuby";

/**
 * ルビの対象の種類を選ぶ画面（作者の裁定、2026-09-08。設計書6.12.5）。
 * 選ぶ画面の説明に出す「読み仮名のある名前 N語」の数え方だけを固める。
 * 画面そのもの（QuickPick）は実機で見る。
 */
describe("読み仮名のある名前の数", () => {
  test("読みが無い・名前と読みが同じものは数えない", () => {
    expect(
      countReadable([
        { name: "密倉文佳", reading: "みくらふみか" },
        { name: "太志", reading: null },
        { name: "ミナ", reading: "ミナ" },
        { name: " ", reading: "よみ" },
      ])
    ).toBe(1);
  });
});
