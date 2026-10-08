import { unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { docxToMarkdown } from "../../../src/core/docxToMarkdown";
import { buildExportDocument } from "../../../src/core/settingsExportProfiles";
import {
  buildExportDocx,
  documentXml,
  escapeXml,
} from "../../../src/core/settingsExportDocx";
import {
  FIXTURE_OPTIONS,
  fixtureData,
} from "../support/settingsExportFixture";

/**
 * 設定資料の Word（.docx）書き出し（F6、設計書6.75.1）。
 *
 * **Word で開けるかは、この試験では確かめられない**（実機確認が要る）。
 * ここで見るのは、①部品がそろった ZIP になっていること、②XML の逃がしと
 * 禁止文字の除去、③このリポジトリの読み手（`docxToMarkdown`）で読み戻すと
 * 見出しと本文が戻ること。
 */

function document(chapter: number | null = null) {
  return buildExportDocument("editorial", fixtureData(), {
    ...FIXTURE_OPTIONS,
    chapter,
  });
}

describe("部品", () => {
  test("最小の5つがそろった ZIP になる", () => {
    const parts = Object.keys(unzipSync(buildExportDocx(document()))).sort();
    expect(parts).toEqual(
      [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/_rels/document.xml.rels",
        "word/document.xml",
        "word/styles.xml",
      ].sort()
    );
  });
});

describe("逃がし", () => {
  test("< > & \" を逃がす", () => {
    expect(escapeXml(`<w:t a="1">&</w:t>`)).toBe(
      "&lt;w:t a=&quot;1&quot;&gt;&amp;&lt;/w:t&gt;"
    );
  });

  test("XML に入れられない制御文字は落とす（Word が開けなくなるため）", () => {
    expect(escapeXml("灯\u0001の\u000B塔\u001F")).toBe("灯の塔");
    // タブと改行は XML に入れてよい
    expect(escapeXml("a\tb")).toBe("a\tb");
  });

  test("作者の値の記号が、XML の構造を壊さない", () => {
    const xml = documentXml(document());
    expect(xml).toContain("&lt;屋根&gt;に銅の風見鶏 &amp; 鐘");
    expect(xml).not.toContain("<屋根>");
  });

  test("値の改行は w:br になる", () => {
    expect(documentXml(document())).toContain(
      '灯を守る役目。</w:t><w:br/><w:t xml:space="preserve">二行目もある。'
    );
  });
});

describe("読み戻し", () => {
  test("見出しと本文が戻る", () => {
    const back = docxToMarkdown(buildExportDocx(document())).markdown;
    expect(back).toContain("# 灯の塔 設定資料（編集部向け）");
    expect(back).toContain("## 登場人物");
    expect(back).toContain("### 窓口課");
    expect(back).toContain("服装：紺のブレザーに赤いマフラー");
    expect(back).toContain("主人公。転生した女子高生。");
    expect(back).toContain("作者が「作者だけ」と印を付けた項目は含めていません");
  });
});
