import { describe, expect, it } from "vitest";
import { buildSceneMemoPanelHtml } from "../../src/views/sceneMemoPanelHtml";

/**
 * シーンメモのパネルの骨組み（設計書6.40.4）。
 *
 * **画面が組み立てられない不具合は、実機でしか気づけない。** ここでは
 * 「そもそもHTMLとして出来ているか」と「作者の指定した口が付いているか」
 * だけを見る。
 */

const html = buildSceneMemoPanelHtml("NONCE123", "vscode-resource:");

describe("シーンメモのパネルのHTML", () => {
  it("スクリプトとスタイルにnonceが入っている", () => {
    expect(html).toContain('<style nonce="NONCE123">');
    expect(html).toContain('<script nonce="NONCE123">');
  });

  it("外から何も読み込ませない（CSP）", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
  });

  /** テンプレートの取り違えで、置き換わらない印が残っていないか */
  it("埋め込みの印が残っていない", () => {
    const body = html.slice(html.indexOf("<body"));
    expect(body).not.toContain("${");
  });

  /** 作者の指定（2026-08-29）「次に飛ばすのと戻る機能を付けてください」 */
  it("次へ・戻るのボタンがある", () => {
    expect(html).toContain('id="prev"');
    expect(html).toContain('id="next"');
    expect(html).toContain("← 戻る");
    expect(html).toContain("次へ →");
    expect(html).toContain('post("next")');
    expect(html).toContain('post("prev")');
  });

  it("絞り込みは、この話だけ・タグ・文字で探すの3つ", () => {
    expect(html).toContain('id="onlyCurrent"');
    expect(html).toContain('id="tag"');
    expect(html).toContain('id="query"');
    expect(html).toContain("この話だけ");
  });

  it("済みにするとMarkdown書き出しの口がある", () => {
    expect(html).toContain('post("done"');
    expect(html).toContain('post("export")');
  });

  /**
   * **作者の書いたものは必ず逃がす。** メモの文には引用符も `<` も入る。
   * 逃がさずに組み立てると、そこで画面が壊れる。
   */
  it("画面に出す値は escapeHtml を通す", () => {
    expect(html).toContain("function escapeHtml(");
    // 一覧の行の組み立てで、素の値を直に挟んでいないか
    const row = html.slice(html.indexOf("function renderRow("));
    const source = row.slice(0, row.indexOf("function render()"));
    expect(source).toContain("escapeHtml(row.text");
    expect(source).toContain("escapeHtml(row.tag)");
    expect(source).toContain("escapeHtml(row.key)");
  });

  /**
   * **色はCSS変数で受ける**（16進は `core/sceneMemo.ts` の1か所。6.40.5）。
   * 画面の中に色の値を書かない。
   */
  it("タグの色はCSS変数で受ける", () => {
    expect(html).toContain("var(--novelai-memo-todo");
    expect(html).toContain("var(--novelai-memo-check");
    expect(html).toContain("var(--novelai-memo-foreshadow");
    expect(html).toContain("var(--novelai-memo-idea");
    expect(html).toContain('"--novelai-" + key');
  });

  /** カーソルに追従して光る行（6.40.4）。**片方向**なので押す口は無い */
  it("いちばん近いメモを光らせる仕掛けがある", () => {
    expect(html).toContain(".memo.active");
    expect(html).toContain("data.activeKey");
  });

  /** 画面は数えない。届いた一覧を描くだけ（計算は拡張機能側） */
  it("画面は本文を読まない（拾い出しは拡張機能側）", () => {
    expect(html).not.toContain("parseMemos");
    expect(html).not.toContain("readTextFile");
  });
});
