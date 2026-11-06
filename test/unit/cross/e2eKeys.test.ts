import { describe, expect, test } from "vitest";
import {
  keybindingFor,
  productKey,
  productKeybinding,
  productKeybindings,
  toPlaywrightChord,
} from "../../e2e/support/keys";

/**
 * 画面の自動テストの「製品のキーを OS に合わせて押す」部品（test/e2e/support/keys.ts）の確かめ（2026-11-06）。
 *
 * Mac で画面テストを流したとき、キーを `Control+…` で決め打ちしていて落ちた。製品のキーは package.json の
 * `key`（Windows・Linux）と `mac` を読んで決めるので、その読み方をここで見張る。**package.json は実物を読む**
 * （写すと、製品のキーを替えたときにここだけ古いまま通ってしまう）。
 *
 * 置き場所は cross（試すのが src ではなく e2e の部品で、package.json もまたぐため）。
 */
describe("画面テストの製品のキー", () => {
  test("mac のあるキー：Windows は Control、Mac は Meta で押す（実物の novelai.addEmphasis）", () => {
    expect(productKeybinding("novelai.addEmphasis", "win32")).toBe("ctrl+alt+k");
    expect(productKeybinding("novelai.addEmphasis", "darwin")).toBe("cmd+alt+k");
    expect(productKey("novelai.addEmphasis", "win32")).toBe("Control+Alt+KeyK");
    expect(productKey("novelai.addEmphasis", "linux")).toBe("Control+Alt+KeyK");
    expect(productKey("novelai.addEmphasis", "darwin")).toBe("Meta+Alt+KeyK");
    // 記号のキー（ctrl+/ → Slash）
    expect(productKey("novelai.addSceneMemo", "win32")).toBe("Control+Slash");
    expect(productKey("novelai.addSceneMemo", "darwin")).toBe("Meta+Slash");
  });

  test("f8・shift+f8 は OS によらずそのまま（実物の novelai.nextSceneMemo・prevSceneMemo）", () => {
    for (const platform of ["win32", "darwin"] as const) {
      expect(productKey("novelai.nextSceneMemo", platform)).toBe("F8");
      expect(productKey("novelai.prevSceneMemo", platform)).toBe("Shift+F8");
    }
  });

  test("mac の無いキーは、Mac でも key のまま押す", () => {
    /*
      いまの package.json は**全部の割り当てに mac がある**ので、実物からは「mac の無いキー」を取れない。
      部品の読み方（keybindingFor）を、mac を書かない1件で確かめる。実物に mac の無いキーが足されたら、
      下の「実物の割り当てが全部読める」がそれも通す
    */
    const binding = { command: "novelai.example", key: "ctrl+alt+shift+l" };
    expect(keybindingFor(binding, "darwin")).toBe("ctrl+alt+shift+l");
    expect(toPlaywrightChord(keybindingFor(binding, "darwin"))).toBe("Control+Alt+Shift+KeyL");
    // mac が空文字でも key へ戻る
    expect(keybindingFor({ ...binding, mac: "" }, "darwin")).toBe("ctrl+alt+shift+l");
  });

  test("実物の割り当てが全部、Windows と Mac の両方で Playwright の書き方へ直せる", () => {
    const bindings = productKeybindings();
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      for (const platform of ["win32", "darwin"] as const) {
        const chord = productKey(binding.command, platform);
        // Mac の押し方に Control が残っていない（mac を書いた割り当ては cmd で押す）
        if (platform === "darwin" && binding.mac !== undefined && !binding.mac.includes("ctrl")) {
          expect(chord, `${binding.command} の Mac の押し方`).not.toContain("Control");
        }
      }
    }
  });

  test("読めないキー・無いコマンドは、黙って別のキーを押さずに止める", () => {
    expect(() => toPlaywrightChord("ctrl+k ctrl+s")).toThrow(/2段/);
    expect(() => toPlaywrightChord("hyper+k")).toThrow(/修飾/);
    expect(() => productKey("novelai.noSuchCommand")).toThrow(/ありません/);
  });
});
