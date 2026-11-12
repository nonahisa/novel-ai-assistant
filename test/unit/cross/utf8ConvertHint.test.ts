import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { UTF8_CONVERT_HINT } from "../../../src/core/utf8ConvertHint";

/**
 * Shift_JIS で書けない字で止めた知らせには、原稿の文字コード変換を案内する（設計書5.4.2、0.149.0。
 * 作者の指示 2026-11-09「知らせる時は、原稿の文字コード変換を案内してください」）。
 *
 * 書き戻しの失敗を作者の文にする所は、どれも `case "encoding_error":` を持つ。その枝が案内の文
 * （`UTF8_CONVERT_HINT`）を使っていることを、ソースを読んで見張る——新しい書き戻しの道を足したときに
 * 案内を落とすと、ここで止まる。
 */
const SRC = path.join(__dirname, "../../../src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** `case "encoding_error":` から、次の `case`・`default`・閉じ括弧までの枝 */
function encodingErrorBranches(source: string): string[] {
  const branches: string[] = [];
  let at = source.indexOf('case "encoding_error":');
  while (at >= 0) {
    const rest = source.slice(at + 'case "encoding_error":'.length);
    const end = rest.search(/\n\s*(case |default:|\})/);
    branches.push(end < 0 ? rest : rest.slice(0, end));
    at = source.indexOf('case "encoding_error":', at + 1);
  }
  return branches;
}

describe("書けない字で止めた知らせは、UTF-8 への変換を案内する", () => {
  const files = sourceFiles(SRC)
    .map((file) => ({ file: path.relative(SRC, file), source: fs.readFileSync(file, "utf8") }))
    .filter(({ source }) => source.includes('case "encoding_error":'));

  test("失敗を文にする所が見つかる（見張りが空振りしていない）", () => {
    // 0.149.0 の時点で8か所（提案の適用・取り込み・原稿箱・改行の統一・plot.md の3か所・MCP）
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  test.each([
    "core/openDocumentEdit.ts",
    "features/eolUnify.ts",
    "features/importOutboxInbox.ts",
    "features/manuscriptImport.ts",
    "features/plotAdvice.ts",
    "features/plotNameSuggest.ts",
    "features/proposalPanel.ts",
    "mcp/tools/bodyWrite.ts",
  ])("%s の encoding_error の枝が案内の文を使う", (relative) => {
    const entry = files.find(({ file }) => file.split(path.sep).join("/") === relative);
    expect(entry, relative).toBeDefined();
    const branches = encodingErrorBranches(entry?.source ?? "");
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      // 定数で使う（文を写すと、片方だけ直る）
      expect(branch).toContain("UTF8_CONVERT_HINT");
      expect(branch).not.toContain(UTF8_CONVERT_HINT);
    }
  });

  test("ほかに encoding_error を文にする所を足したら、ここにも並べる", () => {
    // 変換の命令そのもの：ここの encoding_error は「Shift_JIS として読めない」で、書けない字ではない
    const exempt = new Set(["features/convertToUtf8.ts"]);
    for (const { file, source } of files) {
      if (exempt.has(file.split(path.sep).join("/"))) continue;
      for (const branch of encodingErrorBranches(source)) {
        expect(branch, file).toContain("UTF8_CONVERT_HINT");
      }
    }
  });
});
