import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";
import "../support/sweepTimeout";

/**
 * 画面の文で「押さえ」と言わない（作者の裁定 2026-11-07 未明）。
 *
 * 校閲のロックを「押さえる」と書いていたが、作者に通じなかった。画面の文は
 * 「校閲中」で言う（「〇〇 は校閲中です。」「〇〇 を校閲中にしました。」）。
 *
 * **コメントは見ない。** コードの中の説明（「頭を押さえる」など）は作者の画面に
 * 出ないので残してよい。行コメントとブロックコメントを落としてから探す。
 * 見るのは `src` の全部と `package.json`（メニューの名前・説明）。
 */

const ROOT = path.join(__dirname, "..", "..", "..");
const SRC = path.join(ROOT, "src");
const WORD = "押さえ";

/** 行コメント・ブロックコメントを落として、実コードだけにする */
function stripComments(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      // 行の後ろのコメント（`x(); // …`）。`https://` の中の `//` は前が `:` なので残る
      .replace(/(^|[^:"'`\\])\/\/[^\n]*$/gm, "$1")
  );
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|js|html|css)$/.test(entry.name) ? [full] : [];
  });
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of walk(SRC)) {
    const name = path.relative(ROOT, file).replace(/\\/g, "/");
    const code = stripComments(fs.readFileSync(file, "utf8"));
    code.split("\n").forEach((line) => {
      if (line.includes(WORD)) found.push(`${name}: ${line.trim()}`);
    });
  }
  const manifest = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  manifest.split("\n").forEach((line, index) => {
    if (line.includes(WORD)) found.push(`package.json:${index + 1}: ${line.trim()}`);
  });
  return found;
}

describe("画面の文で「押さえ」と言わない", () => {
  test("src と package.json の文字列に「押さえ」が無い", () => {
    // 落ちたら：その文を「校閲中」で言い換える（〇〇 は校閲中です／〇〇 を校閲中にしました）
    expect(offenders()).toEqual([]);
  });
});
