import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 「校正をまとめて実行」の中止ボタンは**1つだけ**——いま走っている検知の
 * ものに寄せる（設計書6.80。0.33.7のレビュー。実機確認リスト F-89 の代わり）。
 *
 * まとめ側も中止ボタン付きの進捗（`withCancellableProgress`）で包むと、
 * ボタンが2つ並び、まとめの側を押しても走っている検知は止まらなかった。
 * 押したあと残りを走らせず知らせを出すことは `proofreadingSuiteRun.test.ts`
 * （「中止したら、残りは走らせない」「中止したら、そこまでの内訳と残りを
 * 伝える」）が見ている。ここは**ボタンを増やしていないこと**をソースの形で見る
 * （コメントは先に落とす——理由を書いたコメントの語で検査が通らないように）。
 */

function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("まとめ実行の中止ボタン", () => {
  const suite = code("src/features/proofreadingSuite.ts");

  test("走っている間の進捗は、中止ボタンの無い形で出す", () => {
    expect(suite).toContain('withProgress("校正一括実行"');
    expect(suite).not.toContain("withCancellableProgress");
    expect(suite).not.toContain("withAiTurnProgress");
  });

  test("その進捗の出し方は、中止を受け付けない", () => {
    const progress = code("src/views/progress.ts");
    const start = progress.indexOf("export function withProgress<T>(");
    const body = progress.slice(start, progress.indexOf("\n}", start));
    expect(body).toContain("vscode.ProgressLocation.Window");
    expect(body).not.toContain("cancellable");
  });
});
