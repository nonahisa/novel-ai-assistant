import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * プロットモードの読み込みは1本ずつ（実機確認リスト 369、2026-10-09）。
 *
 * 開いた直後に `initialize()` と `ready` の知らせが読み込みを重ねて始め、
 * 知らせの帯に同じ断りが2回続けて出ていた。画面で起きることは
 * `test/e2e/plotModeNoticeOnce.test.ts` が見張る。ここは、読み込みの口（`load`）が
 * 前の読み込みに続けて走らせる形であることと、知らせの器を空にするのが
 * 1本ぶんの読み込み（`loadOnce`）の中であることを、ソースの形で見る
 * （パネルは `vscode` の画面そのものなので動かせない。`plotModePanelPlanned` と同じ）。
 */

function bodyOf(file: string, marker: string): string {
  const source = readFileSync(path.join("src", "features", file), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`${marker} が見つかりません`);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${marker} の閉じ括弧が見つかりません`);
}

describe("プロットモードの読み込み", () => {
  it("load は前の読み込みに続けて loadOnce を走らせる（重ねない）", () => {
    const body = bodyOf("plotModePanel.ts", "private load(");
    expect(body).toContain("this.loading");
    expect(body).toContain("this.loadOnce()");
    // 直に読み込みの中身を持たない（器を空にするのは loadOnce だけ）
    expect(body).not.toContain("this.notices = []");
  });

  it("知らせの器を空にするのは、1本ぶんの読み込みの頭", () => {
    const body = bodyOf("plotModePanel.ts", "private async loadOnce(");
    expect(body.indexOf("this.notices = []")).toBeGreaterThan(-1);
    expect(body.indexOf("this.notices = []")).toBeLessThan(body.indexOf("this.post("));
  });
});
