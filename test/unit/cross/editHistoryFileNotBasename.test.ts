import { describe, expect, test } from "vitest";
import "../support/sweepTimeout";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 編集履歴（`recordEdit`）の `file` に、ファイル名だけ（`path.basename(...)`）を渡さない。
 *
 * ## なぜ機械で止めるか
 *
 * `file` は「作品フォルダーからの相対パス」（`core/editHistoryFormat.ts`）。
 * 0.130.3 までは11か所が名前だけを書いており、章ごとのフォルダーに同じ名前の話が
 * あると、タイムラインの欄がほかの章の話の記録まで拾っていた。呼び手は機能ごとに
 * 散っているので、新しく足す1か所がまた `basename` を写しやすい。
 *
 * 書くときは `editHistoryFile(work.folderPath, 絶対の場所)` を使う。
 */
const SRC = path.resolve(__dirname, "../../../src");

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
}

describe("編集履歴の file", () => {
  test("recordEdit の file に path.basename を渡していない", () => {
    const files: string[] = [];
    walk(SRC, files);
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      // 呼び出しの引数（最初の `});` まで）だけを見る。画面の文の basename は対象外
      const calls = text.matchAll(/recordEdit\(([\s\S]*?)\}\);/g);
      for (const call of calls) {
        if (/\bfile:\s*path\.basename\(/.test(call[1])) {
          const line = text.slice(0, call.index).split("\n").length;
          offenders.push(`${path.relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
