import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * ソースに生のNUL文字（U+0000）を置かない。
 *
 * ## なぜ機械で止めるか
 *
 * 生のNULが1文字でも入ると、**gitとgrepがそのファイルをバイナリ扱いする**。
 * 差分は「Binary files differ」になり、検索は素通しになる。
 * `characterUnify.ts` の注釈が「実際にそうなっていた」と警告していたのに、
 * 4ファイルで再発していた（2026-08-27の点検で発見）。
 *
 * しかもこの隠れ方は実害に直結した：`checkContradictions.ts` では
 * 索引の書く側（空白区切り）と読む側（生NUL区切り）の鍵がずれて
 * **読みが一度も当たっていなかった**が、ファイルがgrepから見えないため
 * 誰も突き合わせられなかった。
 *
 * 区切り文字が要るときは `"\u0000"` とエスケープで書く。動きは同じで、
 * ファイルはテキストのまま残る。
 */
const BS = String.fromCharCode(92);

describe("ソースの衛生", () => {
  test("生のNUL文字が無い", () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|mts|cts|js|mjs|cjs|json|md)$/.test(entry.name)) continue;
        const body = fs.readFileSync(full);
        if (body.includes(0)) offenders.push(full.split(BS).join("/"));
      }
    };

    for (const root of ["src", "test", "scripts", "docs"]) walk(root);

    expect(
      offenders,
      "生のNUL文字が入っている。\u0000 のエスケープで書き直すこと" +
        "（git・grepがバイナリ扱いして、差分も検索も効かなくなる）"
    ).toEqual([]);
  });
});
