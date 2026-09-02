import { describe, expect, it } from "vitest";
import { buildEpubEditorPanelHtml } from "../../src/views/epubEditorPanelHtml";

/**
 * EPUBエディターの画面（設計書6.65.6）。
 *
 * 見え方の良し悪しは実機でしか分からない。ここで見るのは
 * 「そもそもHTMLとして出来ているか」と「守るべき約束が入っているか」だけ
 * （年表・人物相関図の画面と同じ考え方）。
 */

const html = buildEpubEditorPanelHtml("NONCE123", "vscode-resource:");
const script = (() => {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

describe("EPUBエディターのHTML", () => {
  it("スクリプトとスタイルにnonceが入っている", () => {
    expect(html).toContain('<style nonce="NONCE123">');
    expect(html).toContain('<script nonce="NONCE123">');
  });

  it("外から何も読み込ませない（CSP）", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
    expect(html).toContain("style-src vscode-resource: 'nonce-NONCE123'");
  });

  it("埋め込みの印が残っていない", () => {
    const body = html.slice(html.indexOf("<body"));
    expect(body).not.toContain("${");
  });

  /** WebViewのスクリプトにバッククォートを書かない（この作品の決まり） */
  it("バッククォートが混ざっていない", () => {
    expect(html.includes("`")).toBe(false);
  });

  it("スクリプトがJavaScriptとして読める", () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it("タグの数が合っている", () => {
    const open = [...html.matchAll(/<div\b/g)].length;
    const close = [...html.matchAll(/<\/div>/g)].length;
    expect(open).toBe(close);
  });
});

describe("左の設定の欄", () => {
  it("書誌情報の4つがある", () => {
    expect(html).toContain('id="bookTitle"');
    expect(html).toContain('id="author"');
    expect(html).toContain('id="illustrator"');
    expect(html).toContain('id="label"');
  });

  it("組み方と空行の詰めがある", () => {
    expect(html).toContain('id="writingMode"');
    expect(html).toContain('id="collapseBlankLines"');
  });

  it("目次のありなし・パターン・飾りがある", () => {
    expect(html).toContain('id="tocEnabled"');
    expect(html).toContain('id="tocPattern"');
    expect(html).toContain('id="tocOrnament"');
  });

  it("奥付の飾りがある", () => {
    expect(html).toContain('id="colophonOrnament"');
  });

  it("保存と書き出しの入口がある", () => {
    expect(html).toContain('id="save"');
    expect(html).toContain('id="export"');
  });
});

describe("右のプレビュー", () => {
  it("面を並べる場所と、本のCSSを流し込む場所がある", () => {
    expect(html).toContain('id="pages"');
    // 本のCSSは拡張機能側から届く。**nonce付きの空の枠**を先に置いておく
    // （あとから作った style は読み込まれない）
    expect(html).toContain('<style nonce="NONCE123" id="book-style">');
  });

  it("組版は拡張機能側で組んだものを受け取る", () => {
    // **画面で組み直さない。** 書き出しと同じ断片を出すのが要件で、
    // ここに組版を書いた時点で「見た目どおり」が壊れる（設計書6.65.6）
    expect(script).toContain("data.pages");
    expect(script).toContain("data.css");
    expect(script).not.toContain("nav-list");
    expect(script).not.toContain("colophon-list");
    expect(script).not.toContain("ornament");
  });

  it("面の並びは拡張機能側が決める（画面は数も順も持たない）", () => {
    // 扉を足したときに画面へ書き足す場所が無いように、
    // 面は `data.pages` を順に並べるだけにしてある
    expect(script).not.toContain("表紙");
    expect(script).not.toContain("タイトルページ");
    expect(script).not.toContain("奥付");
  });

  it("面の見出しと注記は、必ずエスケープを通す", () => {
    expect(script).toContain("function escapeHtml");
    expect(script).toContain("escapeHtml(page.label)");
    expect(script).toContain("escapeHtml(page.note)");
  });
});

describe("画面から拡張機能へ返すもの", () => {
  it("準備完了・変更・保存・書き出しを返す", () => {
    expect(script).toContain("post('ready'");
    expect(script).toContain("post('change'");
    expect(script).toContain("post('save'");
    expect(script).toContain("post('export'");
  });

  it("book.json を画面から直接書かない", () => {
    // 保存はハッシュ照合つきで拡張機能側が行う（設計書6.65.6）
    expect(script).not.toContain("book.json");
    expect(script).not.toContain("writeFile");
  });
});
