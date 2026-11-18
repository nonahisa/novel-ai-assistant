import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";
import {
  CHOSEN_FONT_LINE_HEIGHT,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_MANUSCRIPT_FONT,
  describeCurrentFont,
  MANUSCRIPT_FONTS,
} from "../../../src/core/manuscriptFonts";

/**
 * 書体を選んでいない人の既定（作者の決定 2026-11-18「なろうに寄せる（ゴシック・16px・行間1.8）」。
 * 設計書6.25.3）。書体を選んだ人（作者の游ゴシックなど）の見た目は変えない。
 */
const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");

/** そのセレクタの { } の中身 */
function block(selector: string): string {
  const head = html.indexOf(selector + " {");
  expect(head, selector + " が無い").toBeGreaterThanOrEqual(0);
  const open = html.indexOf("{", head);
  return html.slice(open + 1, html.indexOf("}", open));
}

describe("原稿エディターの既定の書体", () => {
  it("既定はゴシック（メイリオ→ヒラギノ角ゴ）で、明朝ではない", () => {
    expect(DEFAULT_MANUSCRIPT_FONT.startsWith('"Meiryo"')).toBe(true);
    expect(DEFAULT_MANUSCRIPT_FONT).toContain("Hiragino Kaku Gothic ProN");
    expect(DEFAULT_MANUSCRIPT_FONT.trim().endsWith("sans-serif")).toBe(true);
  });

  it("打つ面と重ねる層と右傍線の欄は、同じ既定の書体と行間で組む（ずれると色の字が重ならない）", () => {
    for (const selector of ["#write, #marks, #compose, #aloudmarks", "#rline"]) {
      const css = block(selector);
      expect(css).toContain(`font-family: var(--novelai-font, ${DEFAULT_MANUSCRIPT_FONT})`);
      expect(css).toContain(`line-height: var(--novelai-line, ${DEFAULT_LINE_HEIGHT})`);
      expect(css).toContain("font-size: var(--novelai-size, 16px)");
      expect(css).not.toContain("Yu Mincho");
    }
  });

  it("書体を選んだ人の行間は今までどおり、既定は 1.8", () => {
    expect(DEFAULT_LINE_HEIGHT).toBe(1.8);
    expect(CHOSEN_FONT_LINE_HEIGHT).toBe(1.9);
  });

  it("書体を既定へ戻したら、前に選んだ書体と行間を外す（開き直さなくても戻る）", () => {
    expect(html).toContain('removeProperty("--novelai-font")');
    expect(html).toContain('removeProperty("--novelai-line")');
    expect(html).toContain(`setProperty("--novelai-line", "${CHOSEN_FONT_LINE_HEIGHT}")`);
    // 埋め込みの数が字のまま残っていない
    expect(html).not.toContain("${");
    expect(html).toContain(`font * ${DEFAULT_LINE_HEIGHT} : 29`);
  });

  it("印（ダッシュ・三点リーダ）の既定も本文と同じゴシック", () => {
    for (const selector of ["#compose .dash", "#compose .ellipsis"]) {
      expect(block(selector)).toContain('var(--novelai-font, "Meiryo", "Hiragino Kaku Gothic ProN")');
    }
  });

  it("選ぶ窓の既定の名前はゴシック", () => {
    expect(MANUSCRIPT_FONTS[0].label).toBe("既定（ゴシックを自動で選ぶ）");
    expect(describeCurrentFont("")).toBe("既定（ゴシックを自動で選ぶ）");
  });
});
