import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 行末の約物を詰めて押し込まない（作者の実機報告、2026-10-27）。
 *
 * 「……診断しています。30人全員が藪医者やったと思いますか？」」の段落が、
 * 組んで書く面で「30」の直後に折り返され、行の右に15字ほど空いた。
 *
 * 原因は Chromium 150（作者の VS Code 1.143 と、画面の自動テストの 1.141 の
 * Electron）の不具合である。既定の text-spacing-trim（normal）は、行末の
 * 「」」を半角に詰めれば収まるときに詰めて収めるが、**収まり切らないと、
 * 直前のテキストノードの境目まで戻って折り返す。** 組んで書く面は
 * 1〜2桁の半角数字を縦中横の印（span.tcy）で包むので、その直後に境目があり、
 * そこまで戻って「30｜人全員が……」になった。禁則（行頭に「？」」を置かない）
 * そのものは正しく働いている。Chromium 153・Edge 156 では起きない。
 *
 * 行末で詰めることをやめれば（space-all）、ふつうの禁則で「思います｜か？」」と
 * 折り返す（隠し窓の Chromium 150 で幅701〜702px・縦書きの高さ590前後と800前後で
 * 確かめた）。約物の対（。」・、「 など）の幅は normal と space-all で変わらない。
 *
 * 画面での見張りは test/e2e/manuscriptLineEndTrim.test.ts（既定の 1.141 が Chromium 150）。
 * ここは `npm run check` で回る守りで、「指定が入っているか」だけを見る。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");

/** `<style>` の中身から CSS のコメントを落とし、規則（選択子の並びと中身）に分ける */
function rules(): { selectors: string[]; body: string }[] {
  const match = html.match(/<style nonce="NONCE123">([\s\S]*?)<\/style>/);
  expect(match, "style が見つからない").toBeTruthy();
  const css = match![1].replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selectors: string[]; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    out.push({ selectors: m[1].split(",").map((s) => s.trim()), body: m[2] });
  }
  return out;
}

describe("行末の約物を詰めない（Chromium 150 の折り返しの戻りすぎを避ける）", () => {
  // 組んで書く面だけでなく、書く面と重ねる2枚の層も揃える。
  // textarea と重ね層で詰め方が違うと、行末で折り返しがずれて色が別の字に乗る
  for (const selector of ["#compose", "#write", "#marks", "#aloudmarks"]) {
    it(`${selector} は text-spacing-trim: space-all`, () => {
      const hit = rules().filter(
        (r) => r.selectors.includes(selector) && /text-spacing-trim\s*:\s*space-all\s*;?/.test(r.body)
      );
      expect(hit.length, `${selector} に text-spacing-trim: space-all が無い`).toBeGreaterThan(0);
    });
  }

  it("ほかの規則で詰め方を上書きしていない", () => {
    const others = rules().filter(
      (r) => /text-spacing-trim\s*:/.test(r.body) && !/text-spacing-trim\s*:\s*space-all/.test(r.body)
    );
    expect(others.map((r) => r.selectors.join(", "))).toEqual([]);
  });
});
