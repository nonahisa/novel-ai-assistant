import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * **面のプレビューは、端末の画面の形にする**（設計書6.65.15）。
 *
 * 作者の指摘（2026-09-13）：「Epubの画面比率ですが、最初のイメージと
 * 縦と横とが逆です。閲覧端末実機では横向きにした場合と縦向きとで、
 * 表示はどう変わるのでしょうか？」
 *
 * それまでの枠は「幅いっぱい・高さ320px」の**横長のスクロール窓**で、
 * 同じ画面の中にある表紙の枠（横1：縦1.4の縦長）と向きが食い違っていた。
 *
 * ## ページを描かない
 *
 * 書き出しているのは**リフロー型**のEPUBである（`rendition:layout` も
 * viewport も出していない）。ページの区切りを決めるのは読む端末なので、
 * 1ページを描いて見せると「そこで切れる」と約束したことになる。
 * 形だけを端末に合わせ、中身はスクロールで読む。
 */

const SOURCE = readFileSync(
  resolve(__dirname, "../../src/views/epubEditorPanelHtml.ts"),
  "utf8"
);

describe("面のプレビューの形", () => {
  test("**縦向きが既定**（表紙の枠と揃える）", () => {
    expect(SOURCE).toContain("aspect-ratio: var(--screen-ratio, 1 / 1.4)");
    expect(SOURCE).toContain('id="screenPortrait"');
    expect(SOURCE).toContain("checked");
  });

  test("横向きへ切り替えられる", () => {
    expect(SOURCE).toContain("--screen-ratio: 1.4 / 1");
    expect(SOURCE).toContain('id="screenLandscape"');
    expect(SOURCE).toContain("screenOrientation = event.target.value");
  });

  test("**高さ320pxの横長の窓は、もう無い**", () => {
    expect(SOURCE).not.toContain("block-size: 320px");
  });

  /**
   * **合成の面（表紙・裏表紙）は、端末の画面の形に押し込めない。**
   *
   * あちらは絵そのもの（横1：縦1.4に焼いたもの）を見せる面である。
   * 端末の画面の形で切ると、焼いた絵と見えているものがずれる。
   */
  test("表紙の面だけは、絵の比率のまま出す", () => {
    expect(SOURCE).toContain(".epub-page.cover-sheet");
    expect(SOURCE).toContain("aspect-ratio: auto");
    expect(SOURCE).toContain("page.compose ? ' cover-sheet' : ''");
  });
});

describe("実機で何が起きるかを、画面で断る", () => {
  test("**ページの区切りは端末が決める**と書いてある", () => {
    expect(SOURCE).toContain("ページの区切りは端末が決めます");
    expect(SOURCE).toContain("リフロー型");
  });

  test("横向きでは見開きになることに触れている", () => {
    expect(SOURCE).toContain("見開き2ページ");
  });
});

/**
 * **向きは本の設定ではない。**
 *
 * 端末の向きは読者が決めるもので、作者が決めるものではない。
 * 台帳へ書くと「作者が縦向きに決めた本」という無い約束ができる。
 */
describe("向きを台帳へ書かない", () => {
  test("切り替えは、拡張機能へ送らずに描き直すだけ", () => {
    const at = SOURCE.indexOf("screenOrientation = event.target.value");
    expect(at).toBeGreaterThan(0);
    const near = SOURCE.slice(at, at + 200);
    expect(near).toContain("renderPages()");
    expect(near).not.toContain("post(");
  });
});

/**
 * EPUBの出力そのものには、画面比率が入っていない。
 *
 * **これが「端末が決める」の根拠である。** 固定レイアウトにすると
 * 読者が文字の大きさを変えられなくなるので、小説では選ばない。
 */
describe("書き出しは、リフロー型のまま", () => {
  const PACKAGE = readFileSync(
    resolve(__dirname, "../../src/core/epubPackage.ts"),
    "utf8"
  );

  test("**固定レイアウトの指定を出さない**", () => {
    expect(PACKAGE).not.toContain("rendition:layout");
    expect(PACKAGE).not.toContain("pre-paginated");
  });

  test("縦組みのときだけ、綴じの向きを出す", () => {
    expect(PACKAGE).toContain('page-progression-direction="rtl"');
  });
});
