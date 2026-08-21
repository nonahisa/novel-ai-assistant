import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ファイルは、作者の既定のエディターで開く（設計書6.17.6）。
 *
 * **`openTextDocument(Uri) + showTextDocument` は、常に素のテキスト
 * エディターで開く。** 作者が `workbench.editorAssociations` で `*.md` に
 * Markdown のエディターを割り当てていても無視される。
 *
 * 実際に起きた（2026-08-21、作者が実機で発見）。`plot.md` だけが
 * 「テキスト エディター」で開き、記法がそのまま並んでいた。作品一覧から
 * 開いた `.md` は Markdown のエディターで出るのに、こちらだけ違っていた。
 *
 * **画面上で作る文書は対象外。** `openTextDocument({content, language})` は
 * URIを持たないので、既定の割り当てという考え方がそもそも無い。
 */

/**
 * エディターの実体（`TextEditor`）が要るので、そのままにしてよい場所。
 *
 * 該当行へ飛ぶ・選択範囲を作る操作には返り値が要る。`vscode.open` は
 * 何も返さないので置き換えられない。**なぜ例外なのかを、ここに書いておく。**
 */
const NEEDS_EDITOR = new Map([
  ["src/features/proposalPanel.ts", "指摘の該当行へ飛び、そこを選択する"],
  ["src/features/ruby.ts", "選んだ範囲へルビを差し込む"],
  ["src/features/workChatPanel.ts", "相談で引用した箇所を選択する"],
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".ts")) out.push(path.split("\\").join("/"));
  }
  return out;
}

describe("ファイルは既定のエディターで開く", () => {
  const files = sources("src");

  it("走査する対象がある", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("実ファイルを openTextDocument で開いていない", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (NEEDS_EDITOR.has(file)) continue;
      const text = readFileSync(file, "utf-8");
      // `openTextDocument(` のあとに `vscode.Uri` が続く形だけを見る。
      // `openTextDocument({content, language})` は画面上の文書なので対象外
      if (/openTextDocument\(\s*\r?\n?\s*vscode\.Uri/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("例外の一覧が、実在するファイルを指している", () => {
    // 消えたファイルを許し続けると、一覧が形だけになる
    for (const file of NEEDS_EDITOR.keys()) {
      expect(files, file).toContain(file);
    }
  });

  it("例外のファイルは、本当にエディターの実体を使っている", () => {
    for (const [file, why] of NEEDS_EDITOR) {
      const text = readFileSync(file, "utf-8");
      // 返り値を受けずに showTextDocument だけ呼んでいるなら、例外の必要が無い。
      // 変数へ入れる形と、そのまま返す形の両方がある
      const usesEditor =
        /(?:const|let)\s+\w+\s*=\s*(?:\(?await\s+)?vscode\.window\.showTextDocument/.test(
          text
        ) || /return\s+vscode\.window\.showTextDocument/.test(text);
      expect(usesEditor, `${file}（${why}）`).toBe(true);
    }
  });
});
