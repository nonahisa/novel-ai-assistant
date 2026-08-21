import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 選択画面には、閉じる道が画面に出ていること（設計書6.17.3）。
 *
 * **Escでも閉じられるが、それを知らない人には出口が無いように見える**
 * （作者の指摘、2026-08-21）。開発者にとっては当たり前でも、
 * 作者はプログラマではない。**押せるものとして見せる。**
 *
 * 例外は複数選択（`canPickMany`）だけ。VS Code が「OK」「キャンセル」の
 * ボタンを自分で出すので、項目として足すとかえって紛らわしい。
 */

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".ts")) out.push(path.split("\\").join("/"));
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  hasCancel: boolean;
  multi: boolean;
}

/**
 * その呼び出しの本体だけを切り出す。
 *
 * **前後を何行か見る、では隣の呼び出しを拾ってしまう。** 実際に、
 * すぐ下にある別の選択画面の `cancelItem` を数えて誤判定した。
 * 括弧の対応を数えて、その呼び出しの範囲だけを見る。
 */
function callText(lines: string[], start: number): string {
  let depth = 0;
  let started = false;
  let text = "";
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "(") {
        depth++;
        started = true;
      } else if (ch === ")") {
        depth--;
      }
    }
    text += lines[i] + "\n";
    if (started && depth <= 0) break;
  }
  return text;
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sources("src")) {
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("showQuickPick")) return;
      const body = callText(lines, index);
      sites.push({
        file,
        line: index + 1,
        hasCancel: /cancelItem\(/.test(body),
        multi: /canPickMany:\s*true/.test(body),
      });
    });
  }
  return sites;
}

describe("選択画面には閉じる道を出す", () => {
  const sites = collectSites();

  it("走査する対象がある", () => {
    // 拾い方を間違えて0件を通す、を防ぐ
    expect(sites.length).toBeGreaterThan(20);
  });

  it("すべての選択画面に「取りやめる」がある", () => {
    const missing = sites
      .filter((site) => !site.hasCancel && !site.multi)
      .map((site) => `${site.file}:${site.line}`);
    expect(missing).toEqual([]);
  });

  it("複数選択は、項目を足さずにVS Codeのボタンへ任せている", () => {
    // 複数選択に「取りやめる」を足すと、チェックできる項目として並ぶ
    const odd = sites
      .filter((site) => site.multi && site.hasCancel)
      .map((site) => `${site.file}:${site.line}`);
    expect(odd).toEqual([]);
  });
});
