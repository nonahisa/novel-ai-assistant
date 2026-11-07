import { describe, expect, test } from "vitest";
import {
  keybindingFor,
  keyLabelFor,
  keyLabelShown,
  productKey,
  productKeyLabel,
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

  test("画面に出るキーの札：Windows は「Ctrl+Alt+M」、Mac は mac の割り当てを記号で「⌥⌘M」（並びは Ctrl→Shift→Alt→Cmd）", () => {
    expect(productKeyLabel("novelai.openSceneMemos", "win32")).toBe("Ctrl+Alt+M");
    expect(productKeyLabel("novelai.openSceneMemos", "darwin")).toBe("⌥⌘M");
    expect(productKeyLabel("novelai.nextSceneMemo", "win32")).toBe("F8");
    expect(productKeyLabel("novelai.nextSceneMemo", "darwin")).toBe("F8");
    expect(productKeyLabel("novelai.prevSceneMemo", "win32")).toBe("Shift+F8");
    expect(productKeyLabel("novelai.prevSceneMemo", "darwin")).toBe("⇧F8");
    expect(productKeyLabel("novelai.addSceneMemo", "win32")).toBe("Ctrl+/");
    expect(productKeyLabel("novelai.addSceneMemo", "darwin")).toBe("⌘/");
    // 書いた順によらず VS Code の札の順に並ぶ
    expect(keyLabelFor("cmd+shift+ctrl+alt+k", "darwin")).toBe("⌃⇧⌥⌘K");
    expect(keyLabelFor("alt+shift+ctrl+k", "win32")).toBe("Ctrl+Shift+Alt+K");
    // 実物の割り当ては全部、両方の OS で札に直せる
    for (const binding of productKeybindings()) {
      for (const platform of ["win32", "darwin"] as const) {
        expect(productKeyLabel(binding.command, platform).length, `${binding.command}（${platform}）`).toBeGreaterThan(0);
      }
    }
  });

  test("札の当て方：前に修飾が付いた別のキーには当てない", () => {
    expect(keyLabelShown("F8", "F8")).toBe(true);
    expect(keyLabelShown("Shift+F8", "F8")).toBe(false);
    expect(keyLabelShown("⇧F8", "F8")).toBe(false);
    expect(keyLabelShown("Shift+F8", "Shift+F8")).toBe(true);
    expect(keyLabelShown("Ctrl+Alt+M", "Ctrl+Alt+M")).toBe(true);
    expect(keyLabelShown("Ctrl+Shift+Alt+M", "Alt+M")).toBe(false);
    expect(keyLabelShown("⌥⌘M", "⌥⌘M")).toBe(true);
    expect(keyLabelShown("⌃⌥⌘M", "⌥⌘M")).toBe(false);
    expect(keyLabelShown("Ctrl+Alt+M", "⌥⌘M")).toBe(false);
  });

  test("読めないキー・無いコマンドは、黙って別のキーを押さずに止める", () => {
    expect(() => toPlaywrightChord("ctrl+k ctrl+s")).toThrow(/2段/);
    expect(() => toPlaywrightChord("hyper+k")).toThrow(/修飾/);
    expect(() => productKey("novelai.noSuchCommand")).toThrow(/ありません/);
  });
});
