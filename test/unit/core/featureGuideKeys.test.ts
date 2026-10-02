import { describe, expect, test } from "vitest";
import { buildGuideBundles, EXTRA_GUIDE } from "../../../src/core/featureGuide";

/**
 * 原稿エディターのキー操作（設計書6.25.10）は、メニューの項目に無いので
 * マニュアルの節として持つ。相談で「ショートカットは？」と訊かれたときに
 * 答えられるよう、束としても選べること。
 */
describe("原稿エディターのキー操作の説明", () => {
  test("EXTRA_GUIDE に、実装したキーがすべて載っている", () => {
    expect(EXTRA_GUIDE).toContain("【原稿エディターのキー操作】");
    for (const key of [
      "Ctrl+S",
      "Ctrl+F",
      "Alt+↑",
      "Ctrl+Shift+R",
      "Ctrl+Shift+K",
      "Ctrl+0",
    ]) {
      expect(EXTRA_GUIDE, key).toContain(key);
    }
    // 変換のキーを奪わないことは、作者が気にする点なので書いておく
    expect(EXTRA_GUIDE).toContain("F6〜F10");
  });

  test("束として選べる", () => {
    const bundle = buildGuideBundles().find((entry) => entry.key === "keys");
    expect(bundle, "キー操作の束がない").toBeTruthy();
    expect(bundle?.label).toBe("原稿エディターのキー操作");
    expect(bundle?.text).toContain("Ctrl+F");
  });
});
