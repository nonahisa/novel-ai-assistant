import { describe, expect, test } from "vitest";
import { buildExportDocument } from "../../../src/core/settingsExportProfiles";
import {
  buildExportHtml,
  escapeHtmlText,
} from "../../../src/core/settingsExportHtml";
import {
  FIXTURE_OPTIONS,
  fixtureData,
} from "../support/settingsExportFixture";

/**
 * 設定資料の HTML 書き出し（F6、設計書6.75.1）。
 *
 * 確かめるのは、①作者の値に入った `<` `&` がタグとして効かないこと、
 * ②外から何も読み込まないこと、③目次から各項目へ飛べること、
 * ④Markdown 版と同じ頭書き（含めた・含めなかった項目）を運ぶこと。
 */

function html(chapter: number | null = null): string {
  return buildExportHtml(
    buildExportDocument("editorial", fixtureData(), { ...FIXTURE_OPTIONS, chapter })
  );
}

describe("逃がし", () => {
  test("< > & \" ' を文字として逃がす", () => {
    expect(escapeHtmlText(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
    );
  });

  test("作者の値に入った記号が、タグとして効かない", () => {
    const page = html();
    // 場所の説明「<屋根>に銅の風見鶏 & 鐘」
    expect(page).toContain("&lt;屋根&gt;に銅の風見鶏 &amp; 鐘");
    expect(page).not.toContain("<屋根>");
    // 掘り下げの本文「<b>&</b>」
    expect(page).toContain("&lt;b&gt;&amp;&lt;/b&gt;");
    expect(page).not.toContain("<b>&</b>");
  });

  test("複数行の値は改行を残す", () => {
    expect(html()).toContain("灯を守る役目。<br>二行目もある。");
  });
});

describe("1枚で完結する", () => {
  test("文字コードと言語を書き、外の部品を読み込まない", () => {
    const page = html();
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('<html lang="ja">');
    expect(page).toContain("<style>");
    expect(page).not.toMatch(/<link\b/);
    expect(page).not.toMatch(/<script\b/);
    expect(page).not.toMatch(/src=/);
    expect(page).not.toMatch(/https?:\/\//);
  });

  test("印刷すると種別ごとに紙が改まる（PDF はこの1枚から作る）", () => {
    expect(html()).toContain("@media print");
    expect(html()).toContain("section.kind { break-before: page; }");
  });
});

describe("目次と表", () => {
  test("目次の飛び先が、すべて本文に在る", () => {
    const page = html();
    const targets = [...page.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(5);
    for (const target of targets) {
      expect(page, target).toContain(`id="${target}"`);
    }
  });

  test("同じ名前が2つあっても、飛び先はぶつからない（連番）", () => {
    const data = fixtureData();
    data.locations = [...data.locations, { ...data.locations[0], id: "loc_009" }];
    const page = buildExportHtml(
      buildExportDocument("editorial", data, { ...FIXTURE_OPTIONS, chapter: null })
    );
    const ids = [...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("項目は表の行（項目名と値）になる", () => {
    expect(html()).toContain(
      '<tr><th scope="row">服装</th><td>紺のブレザーに赤いマフラー</td></tr>'
    );
  });

  test("頭書き（含めた項目・含めなかった項目・断り書き）を運ぶ", () => {
    const page = html(3);
    expect(page).toContain("<h2>この資料に含めた項目</h2>");
    expect(page).toContain("<h2>この資料に含めなかった項目</h2>");
    expect(page).toContain("第3話までに絞ったため");
  });
});
