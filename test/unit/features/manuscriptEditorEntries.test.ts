import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
} from "../../src/features/manuscriptEditor";

/**
 * 原稿エディタの入口（作者の依頼、2026-08-27。設計書6.25.4）。
 *
 * VS Code の「エディターを再度開く」に「原稿（縦書）」と「原稿（横書）」が並ぶ。
 * **名前もIDも `package.json` に文字列で書く**ので、片方を直し忘れると
 * 「選べるのに開かない入口」ができる。ここで固める。
 */

interface Manifest {
  contributes: {
    customEditors: Array<{ viewType: string; displayName: string }>;
  };
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
const source = readFileSync("src/extension.ts", "utf8");

describe("原稿エディタの入口", () => {
  test("縦書と横書の2つを出す", () => {
    const names = manifest.contributes.customEditors.map(
      (entry) => entry.displayName
    );

    // 送り仮名を落とした形にそろえる（作者の指定、2026-08-27）
    expect(names).toEqual(["原稿（縦書）", "原稿（横書）"]);
  });

  test("IDが、コードの持つものと一致する", () => {
    const ids = manifest.contributes.customEditors.map((entry) => entry.viewType);

    expect(ids).toEqual([
      MANUSCRIPT_EDITOR_VIEW_TYPE,
      MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
    ]);
  });

  test("どちらも登録している", () => {
    // 片方しか登録していないと、選んでも開かない入口ができる
    expect(source).toContain("MANUSCRIPT_EDITOR_VIEW_TYPE");
    expect(source).toContain("MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE");
  });

  test("横書の入口は、向きを決め打つ", () => {
    // 「原稿（横書）」で開いたのに、その原稿が覚えた縦が勝つと、選んだ意味が無い
    expect(source).toContain('"horizontal"');
  });

  test("どちらも、既定のエディタにはしない", () => {
    // 既定にすると、ふつうに .txt を開いただけで原稿エディタが出る（設計書6.25）
    for (const entry of manifest.contributes.customEditors as Array<{
      priority?: string;
    }>) {
      expect(entry.priority).toBe("option");
    }
  });
});
