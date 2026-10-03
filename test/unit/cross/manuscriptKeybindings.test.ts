import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
} from "../../../src/core/manuscriptViewTypes";
import {
  MANUSCRIPT_KEY_BINDINGS,
  MANUSCRIPT_KEY_SOURCE,
} from "../../../src/core/manuscriptKeys";

/**
 * 原稿エディターを開いているときだけ効くキー割り当て（作者の裁定、2026-10-02。
 * 設計書6.25.10）。
 *
 * **VS Code は割り当ての書き損じを何も言わない。** コマンド名を間違えても、
 * when 句が広すぎても、静かに効かない（または本文の外でも効く）だけなので、
 * package.json の宣言そのものを見張る。
 */

interface Keybinding {
  key: string;
  mac?: string;
  command: string;
  when?: string;
  args?: unknown;
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    keybindings?: Keybinding[];
    customEditors: Array<{ viewType: string }>;
  };
};

const bindings = manifest.contributes.keybindings ?? [];
const ours = bindings.filter((binding) =>
  MANUSCRIPT_KEY_BINDINGS.some((entry) => entry.command === binding.command)
);

/** 作者の裁定の表（2026-10-02）。ここを変えるときはマニュアルも直す */
const EXPECTED: Record<string, string> = {
  "ctrl+alt+t": "novelai.checkTyposForFile",
  "ctrl+alt+p": "novelai.checkProofread",
  "ctrl+alt+h": "novelai.checkNotation",
  "ctrl+alt+a": "novelai.runProofreadingSuite",
  "ctrl+alt+m": "novelai.openSceneMemos",
  // メモの3つは同時押しを減らした（作者の裁定、2026-10-03）
  f8: "novelai.nextSceneMemo",
  "shift+f8": "novelai.prevSceneMemo",
  "ctrl+/": "novelai.addSceneMemo",
  "ctrl+alt+c": "novelai.openChat",
  // 傍点（K は圏点）。2026-10-03 に画面の Ctrl+Shift+K から移した
  "ctrl+alt+k": "novelai.addEmphasis",
  // ルビ。2026-10-03 に画面の Ctrl+Shift+R から移した（傍点と同じ形に）
  "ctrl+alt+r": "novelai.addRuby",
};

describe("原稿エディターのキー割り当て（package.json）", () => {
  test("11件あり、裁定の表と同じ組み合わせ", () => {
    expect(ours).toHaveLength(11);
    const actual = Object.fromEntries(
      ours.map((binding) => [binding.key, binding.command])
    );
    expect(actual).toEqual(EXPECTED);
  });

  test("core の一覧（マニュアルが読む表）と package.json が食い違わない", () => {
    expect(
      Object.fromEntries(
        MANUSCRIPT_KEY_BINDINGS.map((entry) => [entry.key, entry.command])
      )
    ).toEqual(EXPECTED);
  });

  test("どのコマンドも commands に宣言がある（名前の書き損じを止める）", () => {
    const declared = new Set(
      manifest.contributes.commands.map((command) => command.command)
    );
    for (const binding of ours) {
      expect(declared.has(binding.command), binding.command).toBe(true);
    }
  });

  test("when は原稿エディター（縦・横）が前面のときだけ", () => {
    const expectedWhen =
      `activeCustomEditorId == '${MANUSCRIPT_EDITOR_VIEW_TYPE}' || ` +
      `activeCustomEditorId == '${MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE}'`;
    for (const binding of ours) {
      expect(binding.when, binding.command).toBe(expectedWhen);
    }
    // 2つの viewType が customEditors に実在すること（片方だけ改名されても止める）
    const viewTypes = manifest.contributes.customEditors.map(
      (editor) => editor.viewType
    );
    expect(viewTypes).toContain(MANUSCRIPT_EDITOR_VIEW_TYPE);
    expect(viewTypes).toContain(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
  });

  test("原稿エディターから呼んだ印（args）を付ける", () => {
    // 印が無いと、コマンドの側は「どの作品か」を画面の選択から推し量り、
    // 作品一覧で別の作品を選んだままだと、そちらで走ってしまう
    for (const binding of ours) {
      expect(binding.args, binding.command).toEqual({
        source: MANUSCRIPT_KEY_SOURCE,
      });
    }
  });

  test("mac は Ctrl を Cmd に読み替える（F8 はそのまま）", () => {
    for (const binding of ours) {
      expect(binding.mac, binding.command).toBe(
        binding.key.replace(/^ctrl\+/, "cmd+")
      );
    }
  });

  /*
    F8 は日本語入力の変換（半角カナ）にも使うが、作者の裁定（2026-10-03）で
    メモの行き来に使う。変換中は画面が本体へ渡さない（manuscriptEditorKeys.test.ts
    「変換中の F8 は本体へ渡さない」）。ほかの変換のキーは今までどおり使わない
  */
  test("変換のキー（F6・F7・F9・F10）と本体の F1・F5・F11・F12・Ctrl+P・Ctrl+Shift+P を使わない", () => {
    const forbidden = /(^|\+)(f1|f5|f6|f7|f9|f10|f11|f12)$|^ctrl\+p$|^ctrl\+shift\+p$/;
    for (const binding of bindings) {
      expect(forbidden.test(binding.key), binding.key).toBe(false);
    }
  });
});

describe("ルビ・傍点のキー（Ctrl+Alt+R・Ctrl+Alt+K）の受け先", () => {
  const extension = readFileSync("src/extension.ts", "utf8");
  const editor = readFileSync("src/features/manuscriptEditor.ts", "utf8");

  test("novelai.addEmphasis は、前面が原稿エディターならそちらへ頼みを送る", () => {
    // 原稿エディターは TextEditor を持たないので、素のエディター向けの
    // addEmphasis だけでは「Markdownを開いてください」で終わる
    expect(extension).toMatch(
      /registerCommand\("novelai\.addEmphasis",[\s\S]{0,300}askNotationInActiveManuscript\("emphasis"\)[\s\S]{0,200}addEmphasis\(\)/
    );
    expect(editor).toMatch(/export function askNotationInActiveManuscript\(/);
    expect(editor).toMatch(/type: "askNotation"/);
  });

  test("novelai.addRuby も同じ形（ルビのキー Ctrl+Alt+R）", () => {
    expect(extension).toMatch(
      /registerCommand\("novelai\.addRuby",[\s\S]{0,300}askNotationInActiveManuscript\("ruby"\)[\s\S]{0,200}addRuby\(\)/
    );
  });
});
