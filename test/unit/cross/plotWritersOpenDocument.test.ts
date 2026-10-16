import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * **plot.md と単話プロットを書き換える口は、開いている文書を先に試す道を通る**（作者の裁定「両方直す」、
 * 2026-10-16）。
 *
 * ディスクを「退避 → 消して作り直す」で書くと、開いたままのエディターが読み直す前に作者が打ったとき
 * Ctrl+S が「The content of the file is newer」で断られる（0.107.8、画面テスト plotRenamePending）。
 * 書き手ごとの振る舞いは各テスト（`plotFileOpenDocument`・`applyChatEdit`・`plotAdvice`・
 * `episodePlotFilesOpenDocument`）で見ている。ここは、関数を呼んで確かめにくい書き手が
 * 古い口へ戻らないことだけを見張る。
 */

function body(file: string, start: string, length = 1600): string {
  const source = readFileSync(file, "utf8");
  const at = source.indexOf(start);
  expect(at, `${file} に ${start} が見つからない`).toBeGreaterThan(-1);
  return source.slice(at, at + length);
}

describe("plot.md を書き換える口", () => {
  test("名前の付け替え（人物の改名）は rewritePlotFile を通る", () => {
    const plot = body("src/features/nameRename.ts", "async function applyToPlot(", 900);
    expect(plot).toContain("rewritePlotFile(");
    expect(plot).not.toContain("writePlotText(");
  });

  test("作品名の変更の見出しの書き換えは、開いている文書を先に試す", () => {
    const heading = body("src/features/renameWork.ts", "const content = await readTextFile(target);", 1400);
    expect(heading).toContain("writeTextFilePreferringOpenDocument(");
    expect(heading).not.toContain("writeTextFilePreservingFormat(");
  });

  test("節を書く口（生成・形式とジャンル・作品の作成・ZIPの取り込み）は rewritePlotFile を通る", () => {
    const sections = body("src/core/plotFile.ts", "export async function writePlotSections(", 400);
    expect(sections).toContain("rewritePlotFile(");
    expect(sections).not.toContain("writePlotText(");
  });

  test("相談パネルの書き込みは rewritePlotFile を通る", () => {
    const plot = body("src/features/applyChatEdit.ts", "async function applyToPlot(", 1000);
    expect(plot).toContain("rewritePlotFile(");
    expect(plot).not.toContain("replaceFile(");
  });
});
