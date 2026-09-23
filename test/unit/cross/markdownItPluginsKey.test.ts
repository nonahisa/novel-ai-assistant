import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * プレビューへルビを差し込む仕掛けの登録（設計書6.12、実機確認 B-1）。
 *
 * VS Code 本体の `markdown-language-features` は
 * `contributes["markdown.markdownItPlugins"]` という**平らな鍵**しか見ない。
 * `"markdown": { "markdownItPlugins": true }` と入れ子で書くと `undefined` に
 * なり、`extendMarkdownIt` が一度も呼ばれない——**ルビもシーンメモの隠しも、
 * 一度も動いていなかった**（2026-09-07 に実機で判明。単体テストは関数を直に
 * 呼ぶので通ってしまう）。入れ子へ戻ると黙って死ぬので、鍵の形を見張る。
 */
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../../package.json"), "utf8")
) as { contributes: Record<string, unknown> };

describe("markdown-it プラグインの登録", () => {
  test("平らな鍵 markdown.markdownItPlugins で宣言している", () => {
    expect(manifest.contributes["markdown.markdownItPlugins"]).toBe(true);
  });

  test("入れ子の markdown.markdownItPlugins は使わない（VS Code が読まない）", () => {
    expect(manifest.contributes["markdown"]).toBeUndefined();
  });
});
