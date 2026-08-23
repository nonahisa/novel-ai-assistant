import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../src/views/manuscriptEditorHtml";

/**
 * 原稿エディタの画面（設計書6.25）。
 *
 * **画面が組み立てられない不具合は、実機でしか気づけない。** ここでは
 * 「そもそもHTMLとして出来ているか」と「守るべき約束が入っているか」だけを見る。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");

describe("原稿エディタのHTML", () => {
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

  it("縦書きと横書きを切り替えるボタンがある", () => {
    expect(html).toContain('id="dir"');
    expect(html).toContain("縦書きと横書きを切り替えます");
  });

  it("書く面と読む面の両方がある", () => {
    expect(html).toContain('<textarea id="write"');
    expect(html).toContain('<div id="read">');
  });

  /** 縦書きは CSS の writing-mode で効かせる */
  it("縦書きの指定が入っている", () => {
    expect(html).toContain("writing-mode: vertical-rl");
  });

  /** 英数字が1文字ずつ縦に積まれないようにする */
  it("文字の向きは mixed にしてある", () => {
    expect(html).toContain("text-orientation: mixed");
    expect(html).not.toContain("text-orientation: upright");
  });

  it("投稿サイト用のコピーがある", () => {
    expect(html).toContain('id="copy"');
  });

  it("右クリックの品書きの置き場がある", () => {
    expect(html).toContain('<div id="menu">');
  });

  /** 変換中の文字を送ると、確定のたびに二重に入る */
  it("IMEの変換中は本文を送らない", () => {
    expect(html).toContain("compositionstart");
    expect(html).toContain("compositionend");
  });

  it("タグの数が合っている", () => {
    const open = [...html.matchAll(/<div\b/g)].length;
    const close = [...html.matchAll(/<\/div>/g)].length;
    expect(open).toBe(close);
  });
});
