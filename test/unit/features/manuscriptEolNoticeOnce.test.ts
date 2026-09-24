import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 改行コードが作品の多数派と違う原稿を開いたときの案内は、**同じファイルには
 * 1回だけ**出す（設計書5.4.2。実機確認リスト F-28 の代わり）。
 *
 * 開き直すたびに出ると、案内そのものが読まれなくなる。原稿エディタは
 * `vscode` の画面そのもので動かせないので、`plotModePanelPlanned.test.ts`
 * と同じく**ソースを読んで、その関数の本体だけ**を調べる（コメントは先に
 * 落とす——「1度だけ」と書いたコメントで検査が通らないように）。
 *
 * 見ているのは次の3つ：
 * 1. 印が付いていれば、何も調べずに抜ける
 * 2. **調べる前に**印を付ける（多数派と揃っていたファイルにも付くので、
 *    開き直すたびに全話を読み直さない。案内を待つ間に開き直しても重ならない）
 * 3. 印はウィンドウの間ずっと残る入れ物（関数の外の Set）に置く
 *
 * 「以降は訊かない」の覚え（`remember`）は `notify.test.ts` の範囲。
 */

const source = readFileSync("src/features/manuscriptEditor.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

function bodyOf(marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`${marker} が見つかりません`);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${marker} の閉じ括弧が見つかりません`);
}

describe("改行コードの違いの案内は、同じファイルに1回だけ", () => {
  const body = bodyOf("private async noticeEolMismatch(");

  test("原稿を開いたときに、この案内を呼ぶ", () => {
    expect(source).toContain("void this.noticeEolMismatch(document);");
  });

  test("印の入れ物は関数の外にあり、ウィンドウの間残る", () => {
    expect(source).toMatch(/^const eolNoticeChecked = new Set<string>\(\);$/m);
  });

  test("印が付いていれば、何も調べずに抜ける", () => {
    const guard = body.indexOf("if (eolNoticeChecked.has(key)) return;");
    expect(guard).toBeGreaterThan(-1);
    // 抜ける判断は、作品の話を読みに行くより前
    expect(guard).toBeLessThan(body.indexOf("this.deps.workEpisodes("));
  });

  test("調べる前に印を付ける（案内を出すより前、最初の待ちより前）", () => {
    const mark = body.indexOf("eolNoticeChecked.add(key);");
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(body.indexOf("await "));
    expect(mark).toBeLessThan(body.indexOf("suggestAction("));
  });

  test("案内は「作品ごと揃える」の入口を持ち、こちらからは書き換えない", () => {
    expect(body).toContain('runLabel: "作品ごと揃える"');
    expect(body).toContain('"novelai.unifyEol"');
    expect(body).not.toMatch(/writeTextFile|atomicWriteFile|workspace\.fs\.writeFile/);
  });
});
