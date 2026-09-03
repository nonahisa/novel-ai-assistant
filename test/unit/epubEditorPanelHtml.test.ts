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

  /**
   * 同梱する書体は、プレビューにも当てる（設計書6.65.11）。
   * **`font-src` を足さないと `@font-face` が読み込まれない。**
   */
  it("書体だけは読み込ませる（プレビューに当てるため）", () => {
    expect(html).toContain("font-src vscode-resource:");
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

/**
 * 右の縦のパレット（設計書6.65.15の段C。作者の指定）。
 *
 * **11種のボタンを上から下へ**、アイコンと短いラベルで並べる。
 * 押せる・押せないと理由は拡張機能側が決めるので、ここにあるのは
 * 「並んでいること」と「押したら何を知らせるか」だけである。
 */
describe("右の縦のパレット（設計書6.65.15）", () => {
  const buttons = [...html.matchAll(/data-block="([^"]+)"/g)].map(
    (match) => match[1]
  );

  it("11種のボタンが、作者の指定した順に並ぶ", () => {
    expect(buttons).toEqual([
      "cover",
      "halfTitle",
      "frontIllustration",
      "sectionArt",
      "toc",
      "characters",
      "chapter",
      "body",
      "afterword",
      "colophon",
      "backCover",
    ]);
  });

  it("アイコンと短いラベルが付く", () => {
    expect(html).toContain('class="palette-icon"');
    expect(html).toContain('class="palette-label"');
    for (const key of buttons) {
      expect(html).toContain(`id="palette-${key}"`);
    }
  });

  /** 押せなくする判断も理由も拡張機能側が持つ（画面で組み立てない） */
  it("押せる・押せないと理由は拡張機能から受け取る", () => {
    expect(script).toContain("data.palette");
    expect(script).toContain("button.disabled = entry.enabled !== true");
    expect(script).toContain("button.title = entry.reason");
    // 「1冊に1つ」の言い方を画面に書かない
    expect(script).not.toContain("1冊に1つ");
  });

  it("押すと、選んでいる面の後ろへ入れてもらう", () => {
    expect(script).toContain("post('insertBlock'");
    expect(script).toContain("index: selected");
  });

  /** 章区切りは面ではない。台帳（設計書6.66）が正なので blocks へ入れない */
  it("章区切りだけは、並びではなく台帳へ知らせる", () => {
    expect(script).toContain("post('addChapter'");
    expect(script).toContain("if (key === 'chapter')");
  });

  /**
   * **ドラッグは作らない**（設計書6.65.15の段C）。webviewでの検証が重く、
   * 掴み損ねたときの巻き戻しも要る。クリック挿入と上へ・下へで確実にする。
   */
  it("ドラッグの仕掛けを持たない", () => {
    expect(html).not.toContain("draggable");
    expect(script).not.toContain("dragstart");
    expect(script).not.toContain("dragover");
    expect(script).not.toContain("drop");
  });
});

describe("本の並びの欄（設計書6.65.15）", () => {
  it("並びを置く場所と、選んだ面の設定の場所がある", () => {
    expect(html).toContain('id="blockList"');
    expect(html).toContain('id="blockSettings"');
    expect(html).toContain('id="blockHeading"');
  });

  it("上へ・下へ・削除で編める", () => {
    expect(script).toContain("post('moveBlock'");
    expect(script).toContain("post('removeBlock'");
    expect(script).toContain("上へ");
    expect(script).toContain("下へ");
  });

  /**
   * **消せない面には、削除のボタンそのものを出さない**（本文がこれに当たる）。
   * 押してから断られるより、初めから無いほうが分かりやすい。
   */
  it("削除のボタンは、消せる面にだけ出す", () => {
    expect(script).toContain("if (block.removable)");
  });

  it("面の呼び名は拡張機能から受け取る（画面で持たない）", () => {
    expect(script).toContain("block.label");
    expect(script).toContain("data.blocks");
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

  it("目次のパターン・見出しの形・飾りがある", () => {
    expect(html).toContain('id="tocPattern"');
    expect(html).toContain('id="tocOrnament"');
  });

  /**
   * **並びが正になった**（設計書6.65.15の段C）。目次・人物紹介を入れるかは
   * 並びに置いてあるかどうかが決めるので、チェック欄そのものを畳んだ。
   * 残しておくと、チェックと並びのどちらが効くのか作者に分からない。
   */
  it("「入れる」のチェック欄を持たない（並びが正）", () => {
    expect(html).not.toContain('id="tocEnabled"');
    expect(html).not.toContain('id="characterPageEnabled"');
    // 送りもしない（送ると、作者が手で書いた値を塗り替える）
    expect(script).not.toContain("tocEnabled");
    expect(script).not.toContain("characterPageEnabled");
  });

  /** 面ごとの設定は、その面を選んだときだけ出す（畳むだけで消さない） */
  it("面ごとの設定の欄が、種類ごとにある", () => {
    for (const name of [
      "cover",
      "backCover",
      "halfTitle",
      "toc",
      "characters",
      "image",
      "body",
      "afterword",
      "colophon",
    ]) {
      expect(html).toContain(`id="pane-${name}"`);
    }
    // 口絵と扉絵は置ける場所だけが違うので、欄は1つを使い回す
    expect(script).toContain("frontIllustration: 'image'");
    expect(script).toContain("sectionArt: 'image'");
  });

  it("口絵・扉絵の欄は、選んだ面の絵を直す", () => {
    expect(html).toContain('id="blockImagePath"');
    expect(html).toContain('id="blockCaption"');
    expect(script).toContain("post('blockEdit'");
  });

  it("奥付の飾りがある", () => {
    expect(html).toContain('id="colophonOrnament"');
  });

  /**
   * 目次の見出しの形（設計書6.65.15の1）。番号＋題／題だけ／番号だけの
   * 3択で、既定（`numberAndTitle`）はいままでどおりの見た目になる。
   */
  it("目次の見出しの形が選べる（番号＋題／題だけ／番号だけ）", () => {
    expect(html).toContain('id="tocEntryStyle"');
    expect(html).toContain('value="numberAndTitle"');
    expect(html).toContain('value="titleOnly"');
    expect(html).toContain('value="numberOnly"');
  });

  it("保存と書き出しの入口がある", () => {
    expect(html).toContain('id="save"');
    expect(html).toContain('id="export"');
  });

  /**
   * あとがき（設計書6.65.15の段B）。**原稿は作者が書く**ので、画面には
   * 書く場所を開く入口だけを置く（中身の欄は作らない）。
   */
  it("あとがきを書く入口があり、原稿の在りかを示す", () => {
    expect(html).toContain('id="openAfterword"');
    expect(html).toContain("設定/書籍/あとがき.md");
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

  /**
   * 枠の余白の色（設計書6.65.15の3）。表紙・裏表紙の枠は横1：縦1.4に
   * 固定してあり、元イラストが違う比率のときに余った部分をこの色で塗る。
   * 文字要素の色（白・黒・任意）とまったく同じ選び方にする。
   */
  it("枠の余白の色を選ぶ欄が、表紙・裏表紙それぞれにある", () => {
    for (const side of ["front", "back"]) {
      expect(html).toContain(`id="${side}-frameBackground-color"`);
      expect(html).toContain(`id="${side}-frameBackground-colorPick"`);
    }
    // 既定は黒。白・任意も選べる
    expect(script).toContain("DEFAULT_FRAME_BACKGROUND = '#000000'");
  });

  /**
   * 表紙・裏表紙の枠（設計書6.65.15の3、作者の指示で4:3から1:1.4へ変更）。
   * canvasの寸法は元イラストの比率ではなく、常にこの枠に固定する
   * ——元イラストは縮めて中央に納め、はみ出させない。
   */
  it("合成の枠は横1：縦1.4に固定する（元イラストの比率をそのまま使わない）", () => {
    expect(script).toContain("FRAME_RATIO = 1.4");
    expect(script).toContain("canvas.width = FRAME_WIDTH");
    expect(script).toContain("canvas.height = FRAME_HEIGHT");
    // 元イラストの寸法をそのまま canvas の大きさにしない
    expect(script).not.toContain("canvas.width = Math.max(1, Math.round(image.naturalWidth");
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
   *
   * 段Cで話を選ぶ欄は**話と章の一覧**になった（設計書6.65.15）。
   * 章の行は台帳から来る読み取り専用の行で、押しても選べない。
   */
  it("話と章の一覧と、段落の一覧を置く場所がある", () => {
    expect(html).toContain('id="episodeList"');
    expect(html).toContain('id="paragraphList"');
    // 位置の超過は、書き出す前にここで見える
    expect(html).toContain('id="placementWarnings"');
  });

  it("章の行は押せない（直すのは作品一覧の右クリック）", () => {
    // 押せる行（話）はボタン、章は div として組む
    expect(script).toContain("entry.kind === 'chapter'");
    expect(script).toContain("chapter-row");
    // 直し方の案内は欄に常に出しておく
    expect(html).toContain("作品一覧の右クリック");
  });

  it("段落の一覧は拡張機能から貰う（画面で本文を切らない）", () => {
    expect(script).toContain("post('episode'");
    expect(script).toContain("data.outline");
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

  /**
   * 焼いた画像を消す入口（設計書6.65.8）。
   *
   * 焼いた画像は元イラストより先に拾われるので、**焼いたあとに元絵を
   * 差し替えても本は変わらない**。消せる道が無いと、作者は
   * `設定/書籍/` を自分で開いて消すしかない。
   */
  it("焼いた画像を消す入口が、表紙・裏表紙それぞれにある", () => {
    expect(html).toContain('id="unbakeFront"');
    expect(html).toContain('id="unbakeBack"');
    expect(html).toContain("焼いた画像を消す");
    expect(script).toContain("post('unbake'");
  });

  /**
   * **合成の欄の外に置く。** 元イラストの指定を消しても焼いた画像は残り
   * （本にも入る）、そのとき合成の欄は畳まれる。中に入れると、消す手立て
   * ごと見えなくなる。
   */
  it("消す入口は、合成の欄の中に入れない", () => {
    const compose = html.indexOf('id="front-compose"');
    expect(compose).toBeGreaterThan(0);
    expect(html.indexOf('id="unbakeFront"')).toBeLessThan(compose);
  });

  it("焼いた画像の注記を出す場所がある（言葉は拡張機能側が持つ）", () => {
    expect(html).toContain('id="front-baked-note"');
    expect(html).toContain('id="back-baked-note"');
    // いつ焼いたかの言い方を画面で組み立てない（設計書6.65.6）
    expect(script).toContain("baked.note");
    expect(script).not.toContain("焼いた画像を表示中");
  });

  /**
   * 登場人物一覧（設計書6.65.11）。面を入れるかは並びが決めるので、
   * ここに残るのは**イラストを添えるか**だけである（段C）。
   */
  it("登場人物一覧の欄は、イラストの有無だけを持つ", () => {
    expect(html).toContain('id="characterPageIcons"');
    expect(html).toContain('id="characterNotice"');
  });

  /**
   * 書体（設計書6.65.11）。**ライセンスの注意書きは常に出す**——
   * 埋め込みが許諾されているかを確かめられるのは作者だけである。
   */
  it("書体の欄と、ライセンスの注意書きがある", () => {
    expect(html).toContain('id="fontBody"');
    expect(html).toContain('id="fontHeading"');
    expect(html).toContain(
      "フォントの埋め込みが許諾されているかは、作者の責任でご確認ください"
    );
  });

  it("注意書きは畳まれない（hidden の中に入れない）", () => {
    // 「使えないときだけ出す」注記（合成の欄）と違い、これは常に見える
    const note = html.indexOf("フォントの埋め込みが許諾されているか");
    expect(note).toBeGreaterThan(0);
    expect(html.slice(note - 400, note)).not.toContain("hidden");
  });
});

describe("選んだ面のプレビュー", () => {
  /**
   * 段Cでプレビューは**選んだ面だけ**になった（作業スペースの下段）。
   * 面と行の突き合わせは番号で行う——同じ呼び名の面（扉絵）が並ぶため。
   */
  it("選んでいる面だけを出す", () => {
    expect(script).toContain("page.blockIndex === selected");
  });

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
