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

/**
 * コメントに書かれた名前を、呼び出しと数えない。
 *
 * 以前は区別が無く、コードのコメントの側で言い回しを避けて回避していた
 * （0.22.13）。行頭の `//` と、ブロックコメントの続き（`*`）だけを飛ばす。
 * 行の途中のコメントまでは追わない（そこに書く人はいない）。
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*");
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sources("src")) {
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("showQuickPick")) return;
      if (isCommentLine(line)) return;
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

/**
 * `createQuickPick` の画面も見る（0.24.3で走査を拡張）。
 *
 * `showQuickPick` と違って、項目（`cancelItem`）や複数選択
 * （`canSelectMany`）は**呼び出しのあとの代入**で決まる。呼び出しの
 * 括弧だけを見ても何も分からないので、呼び出し行から「次の関数宣言か、
 * 次の `createQuickPick`」までを1つの画面として切り出す。
 * この作品では画面ごとに関数を分けているので、この区切りで足りる。
 */
function collectCreatedSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sources("src")) {
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("createQuickPick")) return;
      if (isCommentLine(line)) return;

      let end = lines.length;
      for (let i = index + 1; i < lines.length; i++) {
        if (
          /^(export\s+)?(async\s+)?function\s/.test(lines[i]) ||
          lines[i].includes("createQuickPick")
        ) {
          end = i;
          break;
        }
      }
      const body = lines.slice(index, end).join("\n");
      sites.push({
        file,
        line: index + 1,
        hasCancel: /cancelItem\(/.test(body),
        multi: /\.canSelectMany\s*=\s*true/.test(body),
      });
    });
  }
  return sites;
}

describe("選択画面には閉じる道を出す", () => {
  const sites = collectSites();
  const created = collectCreatedSites();

  it("走査する対象がある", () => {
    // 拾い方を間違えて0件を通す、を防ぐ
    expect(sites.length).toBeGreaterThan(20);
    // createQuickPick は少ない（いまは実機確認メニューの2画面だけ）。
    // 増減したら、切り出しの区切りが正しく働いているかも見直す
    expect(created.length).toBeGreaterThanOrEqual(2);
  });

  it("すべての選択画面に「取りやめる」がある", () => {
    const missing = [...sites, ...created]
      .filter((site) => !site.hasCancel && !site.multi)
      .map((site) => `${site.file}:${site.line}`);
    expect(missing).toEqual([]);
  });

  it("複数選択は、項目を足さずにVS Codeのボタンへ任せている", () => {
    // 複数選択に「取りやめる」を足すと、チェックできる項目として並ぶ
    const odd = [...sites, ...created]
      .filter((site) => site.multi && site.hasCancel)
      .map((site) => `${site.file}:${site.line}`);
    expect(odd).toEqual([]);
  });
});
