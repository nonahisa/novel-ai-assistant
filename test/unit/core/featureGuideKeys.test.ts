import { describe, expect, test } from "vitest";
import { buildGuideBundles, EXTRA_GUIDE } from "../../../src/core/featureGuide";
import { MANUSCRIPT_KEY_BINDINGS } from "../../../src/core/manuscriptKeys";

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
      "Ctrl+0",
    ]) {
      expect(EXTRA_GUIDE, key).toContain(key);
    }
    // 傍点・ルビ・メモのキーは 2026-10-03 に変えた。古いキーを案内に残さない
    for (const old of [
      "Ctrl+Shift+K",
      "Ctrl+Shift+R",
      "Ctrl+Alt+Shift+M",
      "Ctrl+Alt+N",
      "Ctrl+Alt+Shift+N",
    ]) {
      expect(EXTRA_GUIDE, old).not.toContain(old);
    }
    // 変換のキーとの関わりは、作者が気にする点なので書いておく
    expect(EXTRA_GUIDE).toContain("変換中");
  });

  test("割り当ての11個と、変え方が載っている（設計書6.25.10）", () => {
    for (const entry of MANUSCRIPT_KEY_BINDINGS) {
      expect(EXTRA_GUIDE, entry.command).toContain(entry.label);
      // package.json の表記（ctrl+alt+t）を、画面の書き方（Ctrl+Alt+T）にして探す
      const shown = entry.key
        .split("+")
        .map((part) => (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
        .join("+");
      expect(EXTRA_GUIDE, entry.command).toContain(shown);
    }
    // 作者が自分で変えられることと、その探し方
    expect(EXTRA_GUIDE).toContain("キーボード ショートカット");
    expect(EXTRA_GUIDE).toContain("Ctrl+K Ctrl+S");
    expect(EXTRA_GUIDE).toContain("小説執筆");
  });

  test("束として選べる", () => {
    const bundle = buildGuideBundles().find((entry) => entry.key === "keys");
    expect(bundle, "キー操作の束がない").toBeTruthy();
    expect(bundle?.label).toBe("原稿エディターのキー操作");
    expect(bundle?.text).toContain("Ctrl+F");
  });
});
