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

/**
 * 日本語入力（IME）が壊れていた（作者の指摘、2026-08-24。設計書6.25.1）。
 *
 * 「入力中にカーソルが飛んだり、文字が重複したり、変換が途中で止まったり」
 *
 * **`<textarea>` にしたのはIMEを守るためだったのに、こちらから壊していた。**
 * 打った本文が文書へ入ると、その文書がそのまま画面へ送り返される。それを
 * 変換中に入れ直していた。
 */
describe("日本語入力を壊さない", () => {
  const code = html.slice(html.indexOf("<script"));

  it("変換中は、打っている面へ入れ直さない", () => {
    // ここが無いと、変換中の文字が消える・二重に入る・変換が止まる
    expect(code).toContain("if (composing)");
    expect(code).toContain("pending = text");
  });

  it("自分が送った本文が返ってきただけなら、触らない", () => {
    expect(code).toContain("lastSent");
    expect(code).toContain("if (text === lastSent) return;");
  });

  it("変換が確定したら、待たせていた書き換えを片づける", () => {
    expect(code).toContain("flushPending");
  });

  /** 打った直後に Ctrl+S を押すと、最後の数文字が保存されないため */
  it("打った本文は、まとめずにその場で送る", () => {
    expect(code).not.toContain("setTimeout(send");
    expect(code).toContain("compositionend");
  });

  it("外から書き換えが来ても、カーソルの位置を保つ", () => {
    expect(code).toContain("replaceKeepingCaret");
    expect(code).toContain("setSelectionRange");
  });

  /** 4万字の本文で、打つたびに千個の段落を作り直すとつかえる */
  it("見えていない「読む」面は、切り替えるまで組み立てない", () => {
    expect(code).toContain("freshHtml");
    expect(code).toContain("applyFreshHtml");
  });
});

/**
 * 打ちながら組み上がりを見る（作者の要望「ワードのようにはできませんか？」）。
 *
 * **打つ面には手を入れない。** ルビを出したまま打てる画面はIMEを壊すので、
 * 見る面を隣に置く形にした（設計書6.25.1）。
 */
describe("並べて書く", () => {
  const code = html.slice(html.indexOf("<script"));

  it("並べるボタンがある", () => {
    expect(html).toContain('id="split"');
  });

  it("並べると、両方の面が見える", () => {
    expect(html).toContain("body.split #write, body.split #read");
    expect(html).toContain("body.reading:not(.split) #write");
  });

  it("組み上がりの側が、カーソルのある行を追いかける", () => {
    expect(code).toContain("followCaret");
    expect(code).toContain("scrollIntoView");
  });

  it("並べた状態を覚える", () => {
    expect(code).toContain("vertical, reading, split, size");
  });
});
