import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * 画面とログに出す IME の呼び名は「Rittoku IME」（2026-11-19 夜 作者の決定）。
 * 漢字の呼び名（六徳 IME）や前の呼び名（オリジナルIME）が、画面に出る文字に戻っていないかを見張る。
 *
 * コメントの行（`//`・`*` で始まる行）は見ない。ドライブの中のフォルダー名
 * `IME_DRIVE_FOLDER_NAME`（"オリジナルIME"）は IME と取り決めたデータの置き場の名前なので変えない。
 */
const root = join(__dirname, "..", "..", "..");
const OLD_NAMES = ["六徳 IME", "六徳IME", "オリジナルIME", "オリジナル IME"];

function codeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  });
}

describe("IME の呼び名（画面とログ）", () => {
  test("package.json（メニュー・設定の説明）に前の呼び名が無い", () => {
    const text = readFileSync(join(root, "package.json"), "utf8");
    for (const name of OLD_NAMES) expect(text.includes(name), name).toBe(false);
    expect(text).toContain("Rittoku IME");
  });

  test("src の文字列に前の呼び名が無い（コメントを除く）", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts")) {
          for (const line of codeLines(readFileSync(p, "utf8"))) {
            if (line.includes("IME_DRIVE_FOLDER_NAME")) continue;
            if (OLD_NAMES.some((name) => line.includes(name))) hits.push(`${p}: ${line.trim()}`);
          }
        }
      }
    };
    walk(join(root, "src"));
    expect(hits).toEqual([]);
  });
});
