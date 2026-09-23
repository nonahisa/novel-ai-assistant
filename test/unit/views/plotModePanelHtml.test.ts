import { describe, expect, it } from "vitest";
import { buildPlotModePanelHtml } from "../../../src/views/plotModePanelHtml";

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
   * プロットの人物を資料へ反映する口（設計書6.4.9）。**パネル内の
   * ボタンだけ**にしてある（操作メニューは増やさない）。
   */
  it("AIを使わない入口があり、押したことを返すだけ", () => {
    expect(html).toContain('id="syncActions"');
    expect(html).toContain("post(target.dataset.action)");
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

/**
 * 予定の話（設計書6.4.8。作者の依頼、2026-09-23）。
 *
 * 行の描き方は画面の中の関数（`renderEpisode`）が持つので、**その関数を
 * 取り出して実際に描かせる**。文字列が含まれるかだけを見ると、描き分けの
 * 条件を取り違えても通ってしまう。
 */
describe("予定の話の描き方", () => {
  function pick(name: string, until: string): string {
    const start = html.indexOf(`function ${name}(`);
    const end = html.indexOf(until, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return html.slice(start, end);
  }

  const renderEpisode = new Function(
    pick("escapeHtml", "/**") +
      pick("renderEpisode", "function renderEpisodes(") +
      "return renderEpisode;"
  )() as (row: Record<string, unknown>) => string;

  const base = {
    filePath: "C:/work/本文/001.txt",
    label: "第1話",
    title: "",
    chapter: 1,
    chars: 1000,
    hasManuscript: true,
    conflicted: false,
    hasEpisodePlot: false,
    canCreateEpisodePlot: true,
    synopsisHead: "",
    checks: [],
    planned: false,
  };

  it("予定の話には「予定」の印が付き、押すと単話プロットを開く", () => {
    const out = renderEpisode({
      ...base,
      filePath: "C:/work/設定/episode-plots/第3話.md",
      label: "第3話",
      title: "嵐の夜",
      chapter: 3,
      chars: 0,
      hasManuscript: false,
      hasEpisodePlot: true,
      planned: true,
      checks: [{ check: "design", label: "設計を検査", detail: "AI" }],
    });

    expect(out).toContain(">予定</span>");
    expect(out).toContain("嵐の夜");
    expect(out).toContain('class="open-body open-plot"');
    expect(out).toContain("本文はまだありません");
    // 行を押せば開くので、「プロット」「単話プロットを作る」は並べない
    expect(out).not.toContain(">プロット</button>");
    expect(out).not.toContain("単話プロットを作る");
    // 本文が無くても、設計の検査は掛けられる
    expect(out).toContain("設計を検査");
  });

  it("書いた話には「予定」の印が付かず、押すと本文を開く", () => {
    const out = renderEpisode({ ...base, hasEpisodePlot: true });

    expect(out).not.toContain(">予定</span>");
    expect(out).toContain('class="open-body"');
    expect(out).toContain(">単話プロット</span>");
  });

  it("予定の話を足す口がある（押したことを返すだけ）", () => {
    expect(html).toContain('id="episodeActions"');
    expect(html).toContain('post("addPlannedEpisode")');
  });
});
