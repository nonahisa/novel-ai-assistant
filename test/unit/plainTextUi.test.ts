import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { diffLinesForPanel } from "../../src/core/characterDiff";
import type { CharacterDiff } from "../../src/core/characterDiff";

/**
 * 画面に出す文字列へ、Markdownの記号を混ぜていないか見張る。
 *
 * VS Code のダイアログ（`showWarningMessage` の `detail`）と選択肢の説明
 * （`QuickPickItem.detail`）は**プレーンテキスト**である。`**強調**` と書くと
 * 記号がそのまま画面に出る。WebViewも同じで、こちらはHTMLを自分で組み立てるため
 * Markdownは解釈されない。
 *
 * 実際に起きた（2026-08-20、作者が実機で発見）。設定資料の更新の差分を
 * `formatDiff`（文書に貼る形）のままパネルへ流しており、`###` が画面に出ていた。
 * 同時に、ダイアログの文言36か所に `**` が混ざっていた。
 *
 * **記号を使ってよいのは、Markdownとして読まれる先だけである。**
 * 下の一覧がその例外で、それ以外のファイルでは記号を禁じる。
 * 新しくMarkdownを書き出すファイルを足したときは、ここへ足すこと
 * （黙って通さないための一覧である）。
 */
const MARKDOWN_ALLOWED = new Set([
  // .md を書き出す
  "src/core/settingsMarkdown.ts",
  "src/core/chatLog.ts",
  "src/core/plotTemplate.ts",
  "src/core/emotionCurve.ts",
  "src/core/characterDiff.ts",
  "src/features/exportImeDictionary.ts",
  "src/features/setupWizard.ts",
  "src/core/synopsisDoc.ts",
  "src/features/applyPendingUpdates.ts",
  // .gitignore に書き込む注釈。Markdownではないが「#」で始まる
  "src/core/workRegistry.ts",
  // MarkdownString（ツールチップ）として渡す
  "src/features/gitSync.ts",
  "src/views/actionList.ts",
  // AIへ渡すプロンプト本文
  "src/core/settingsSchema.ts",
  "src/prompts/characterExtract.ts",
  "src/prompts/proofread.ts",
  "src/prompts/settingsEnrich.ts",
  // 記録ファイル（人が読む前提のログ）
  "src/core/logger.ts",
]);

function collectSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      collectSources(path, out);
    } else if (name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

/** コメント行を除いた、二重引用符の中身だけを取り出す */
function stringLiterals(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("*") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }
    for (const match of line.matchAll(/"[^"]*"/g)) {
      found.push(match[0]);
    }
  }
  return found;
}

describe("画面に出す文字列にMarkdownの記号を混ぜない", () => {
  const files = collectSources("src");

  it("走査する対象がある", () => {
    // 一覧の作り方を間違えて0件を通す、を防ぐ
    expect(files.length).toBeGreaterThan(50);
  });

  for (const file of files) {
    const key = file.split("\\").join("/");
    if (MARKDOWN_ALLOWED.has(key)) continue;

    it(`${key} に強調と見出しの記号がない`, () => {
      const offenders = stringLiterals(readFileSync(file, "utf-8")).filter(
        (literal) => {
          // glob（"**/*.json"）は記法ではなくファイルの指定なので除く
          if (literal.includes("*/") || literal.includes("/*")) return false;
          if (literal.includes("**")) return true;
          // 行頭の見出し。文中の「###」は考えにくいので行頭だけを見る
          return /^"#{1,6}\s/.test(literal);
        }
      );
      expect(offenders).toEqual([]);
    });
  }
});

describe("diffLinesForPanel", () => {
  const diff: CharacterDiff = {
    name: "佐藤",
    filePath: "characters/sato.json",
    changes: [
      { field: "age", label: "年齢", before: "17", after: "18" },
      { field: "role", label: "役割", before: "", after: "主人公" },
    ],
  } as CharacterDiff;

  it("Markdownの記号を含まない", () => {
    for (const line of diffLinesForPanel(diff)) {
      expect(line).not.toContain("**");
      expect(line.trimStart().startsWith("#")).toBe(false);
      expect(line.trimStart().startsWith("- ")).toBe(false);
    }
  });

  it("変更の中身は残る", () => {
    const lines = diffLinesForPanel(diff);
    expect(lines.join("\n")).toContain("年齢");
    expect(lines.join("\n")).toContain("17");
    expect(lines.join("\n")).toContain("18");
    // 未設定は空白のままにせず、そう書く
    expect(lines.join("\n")).toContain("（未設定）");
  });

  it("変更が無いときも1行返す", () => {
    expect(diffLinesForPanel({ ...diff, changes: [] })).toEqual([
      "変更はありません。",
    ]);
  });
});
