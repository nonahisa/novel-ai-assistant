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

  /**
   * 作者のイラストを画面に出すのはここが初めて（設計書6.65.8）。
   * **`img-src` を足さないと、`asWebviewUri` で作ったURIでも出ない。**
   */
  it("画像だけは読み込ませる（作品フォルダと、焼く前の下絵）", () => {
    expect(html).toContain("img-src vscode-resource: data:");
    // 画像以外の口は開けたままにしない
    expect(html).not.toContain("connect-src");
    expect(html).not.toContain("img-src *");
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

  /**
   * 表紙・裏表紙の合成（設計書6.65.8）。要素は4つ、置き場所は9か所の
   * プリセット。**座標は持たない**（自由ドラッグにすると、book.json に
   * 小数が並んで差分が読めなくなる）。
   */
  it("表紙・裏表紙それぞれに、4要素ぶんの欄がある", () => {
    for (const side of ["front", "back"]) {
      for (const element of ["title", "author", "illustrator", "label"]) {
        expect(html).toContain(`id="${side}-${element}-visible"`);
        expect(html).toContain(`id="${side}-${element}-anchor"`);
        expect(html).toContain(`id="${side}-${element}-size"`);
        expect(html).toContain(`id="${side}-${element}-color"`);
        expect(html).toContain(`id="${side}-${element}-vertical"`);
      }
    }
  });

  it("置き場所は9つのプリセットだけ", () => {
    const anchors = [
      "top-left",
      "top-center",
      "top-right",
      "middle-left",
      "middle-center",
      "middle-right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ];
    for (const anchor of anchors) {
      expect(html).toContain(`value="${anchor}"`);
    }
    // 座標を入れる欄は持たない
    expect(html).not.toContain('id="front-title-x"');
  });

  /**
   * 挿絵とページ分割（設計書6.65.10）。話を選び、段落の一覧から
   * 「ここに挿絵」「ここで改ページ」を付け外しする。
   */
  it("話を選ぶ欄と、段落の一覧を置く場所がある", () => {
    expect(html).toContain('id="episodeSelect"');
    expect(html).toContain('id="paragraphList"');
    // 位置の超過は、書き出す前にここで見える
    expect(html).toContain('id="placementWarnings"');
  });

  it("段落の一覧は拡張機能から貰う（画面で本文を切らない）", () => {
    expect(script).toContain("post('episode'");
    expect(script).toContain("data.episodes");
  });

  it("段落の見出しは textContent で入れる（本文をHTMLとして解釈しない）", () => {
    expect(script).not.toContain("innerHTML = paragraph");
    expect(script).toContain("ここに挿絵");
    expect(script).toContain("ここで改ページ");
  });

  it("焼く入口と、元イラストの場所を書く欄がある", () => {
    expect(html).toContain('id="bakeFront"');
    expect(html).toContain('id="bakeBack"');
    expect(html).toContain('id="coverImagePath"');
    expect(html).toContain('id="backCoverImagePath"');
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

  it("焼いたPNGはdataURLで渡す", () => {
    // 合成できるのはcanvasだけ。焼いた結果を**ファイルにするのは
    // 拡張機能側**である（設計書6.65.8）
    expect(script).toContain("post('bake'");
    expect(script).toContain("toDataURL('image/png')");
  });

  it("画像が読めなかったときは、拡張機能へ中身を頼み直す", () => {
    // `asWebviewUri` の画像をcanvasへ描くと、環境によっては
    // 「汚れた canvas」になって `toDataURL` が落ちる。落ちたら
    // 拡張機能からバイト列（dataURL）を貰って描き直す
    expect(script).toContain("post('imageData'");
  });
});
