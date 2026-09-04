import { describe, expect, it } from "vitest";
import { buildPlotModePanelHtml } from "../../src/views/plotModePanelHtml";

/**
 * プロットモードのパネルの骨組み（設計書6.4.8）。
 *
 * **この画面は plot.md の中身を持たない。** 目次・候補・話の一覧だけを
 * 描き、書くのは左のエディタである（6.4.3。欄に写した時点でこの機能の
 * 否定になる）。ここではその約束と、画面が組み立てられていることを見る。
 */

const html = buildPlotModePanelHtml("NONCE123", "vscode-resource:");

describe("プロットモードのパネルのHTML", () => {
  it("スクリプトとスタイルにnonceが入っている", () => {
    expect(html).toContain('<style nonce="NONCE123">');
    expect(html).toContain('<script nonce="NONCE123">');
  });

  it("外から何も読み込ませない（CSP）", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
  });

  it("埋め込みの印が残っていない", () => {
    const body = html.slice(html.indexOf("<body"));
    expect(body).not.toContain("${");
  });

  it("3つの区画がある（目次・AIの入口・話の一覧）", () => {
    expect(html).toContain('id="headings"');
    expect(html).toContain('id="candidates"');
    expect(html).toContain('id="aiActions"');
    expect(html).toContain('id="episodes"');
  });

  it("目次を押すと、行を指して飛ばす", () => {
    expect(html).toContain('post("reveal"');
  });

  it("候補を押すと、見出しを足す（拡張機能側へ頼む）", () => {
    expect(html).toContain('post("addSection"');
  });

  it("単話プロットは、作る口と開く口の両方がある", () => {
    expect(html).toContain('post("createEpisodePlot"');
    expect(html).toContain('post("openEpisodePlot"');
  });

  it("AIの入口は、コマンドIDを返すだけ（画面に処理を持たない）", () => {
    expect(html).toContain('post("command"');
  });

  /**
   * **plot.md の中身を欄に写さない**（設計書6.4.3・6.4.8）。
   * 書き換える口を持たせると、そこから「フォームで書く」へ戻る。
   */
  it("本文を書き換える欄を持たない", () => {
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('post("save"');
  });

  it("画面に出す値は escapeHtml を通す", () => {
    expect(html).toContain("function escapeHtml(");
    const row = html.slice(html.indexOf("function renderEpisode("));
    const source = row.slice(0, row.indexOf("function render()"));
    expect(source).toContain("escapeHtml(row.label)");
    expect(source).toContain("escapeHtml(row.synopsisHead)");
  });

  it("HTMLを流し込んだ直後に、受け手が居ることを知らせる", () => {
    expect(html).toContain('post("ready")');
  });
});
