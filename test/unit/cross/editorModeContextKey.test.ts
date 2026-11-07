import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { EDITOR_MODE_CONTEXT } from "../../../src/core/editorModeContext";

/**
 * 編集者モードの欄の出し分けを、VS Code の設定の読み（`config.novelai.mode`）に頼らない
 * （2026-11-07 作者の実機。VS Code 1.145.2・0.130.3）。
 *
 * 拡張機能は編集者モードと読んでいた（簡単ステップメニューの手順が0個で「選択作品：」だけが出た）のに、
 * 欄の `when` の `config.novelai.mode` は editor と読まれず、簡単ステップメニューが残り、
 * 編集者メニューが出なかった。同じ設定を拡張機能と画面で別に読んでいたので、
 * **拡張機能が自分で印（setContext）を立て、`when` はその印だけを見る**。
 */
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  contributes: {
    views: Record<string, Array<{ id: string; when?: string }>>;
    menus: Record<string, Array<{ command?: string; when?: string }>>;
  };
};

function allWhens(): string[] {
  const views = Object.values(pkg.contributes.views).flat();
  const menus = Object.values(pkg.contributes.menus).flat();
  return [...views, ...menus].map((entry) => entry.when ?? "");
}

describe("編集者モードの出し分けは、拡張機能が立てる印で行う", () => {
  test("package.json の when に config.novelai.mode が残っていない", () => {
    expect(allWhens().filter((when) => when.includes("config.novelai.mode"))).toEqual([]);
  });

  test("編集者メニューは印が立ったときだけ、簡単ステップメニューは立っていないときだけ出る", () => {
    const views = pkg.contributes.views["novelai"];
    expect(views.find((view) => view.id === "novelai.editorMenu")?.when).toMatch(
      new RegExp(`(^|[^!])${EDITOR_MODE_CONTEXT.replace(".", "\\.")}\\b`)
    );
    expect(views.find((view) => view.id === "novelai.steps")?.when).toContain(`!${EDITOR_MODE_CONTEXT}`);
  });

  test("起動したとき・設定が変わったとき・モードを書いたときに印を立てる", () => {
    const extension = readFileSync("src/extension.ts", "utf8");
    const switchMode = readFileSync("src/features/switchMode.ts", "utf8");
    // 起動の道（ビューを出す前）と設定の変化の受け口の両方で立てる
    expect(extension.match(/syncEditorModeContext\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(switchMode).toContain("syncEditorModeContext(");
  });
});
