import * as path from "path";
import { describe, expect, test } from "vitest";
import "../support/sweepTimeout";
import { SRC, relativeName, walkAllImports } from "../support/importGraph";

/**
 * 画面の部品（`@vscode-elements/elements` と、その中身の `lit`）が、拡張機能の束へ入らないこと
 * （作者の決定 2026-11-15）。
 *
 * この部品は読み込まれた瞬間に `customElements.define` を呼ぶ。拡張機能が動く所（拡張機能ホスト）には
 * `customElements` が無いので、`extension.ts` から一度でも届くと、手元でもブラウザ版でも起動した瞬間に
 * 落ちる。画面は別の束（`dist/webview-elements.js`）を `<script src>` で読む。
 *
 * 押したときに初めて読まれるファイルも数に入れるため、動的 import もたどる（`walkAllImports`）。
 */
const ENTRY = path.join(SRC, "extension.ts");
const ELEMENTS_ENTRY = path.join(SRC, "vendor", "webviewElementsEntry.ts");
const WEBVIEW_ONLY = /^(@vscode-elements\/|lit$|lit\/|lit-html|lit-element|@lit\/)/;

describe("画面の部品は拡張機能の束へ入らない", () => {
  test("extension.ts から @vscode-elements・lit へ届かない", () => {
    const reach = walkAllImports([ENTRY]);
    const hits = reach.bare
      .filter((entry) => WEBVIEW_ONLY.test(entry.spec))
      .map((entry) => `${relativeName(entry.file)} → ${entry.spec}`);
    expect(hits).toEqual([]);
    expect(reach.files.has(ELEMENTS_ENTRY)).toBe(false);
  });

  test("たどり方が空振りしていない（部品の入口からは部品が見える）", () => {
    // 入口から見えないなら、上の検査は何も見ずに通っている
    const reach = walkAllImports([ELEMENTS_ENTRY]);
    expect(reach.bare.some((entry) => WEBVIEW_ONLY.test(entry.spec))).toBe(true);
  });
});
