import { describe, expect, it } from "vitest";
import { buildSceneMemoPanelHtml } from "../../../src/views/sceneMemoPanelHtml";

/**
 * シーンメモのパネルの骨組み（設計書6.40.4）。
 *
 * **画面が組み立てられない不具合は、実機でしか気づけない。** ここでは
 * 「そもそもHTMLとして出来ているか」と「作者の指定した口が付いているか」
 * だけを見る。
 */

const html = buildSceneMemoPanelHtml("NONCE123", "vscode-resource:");

describe("シーンメモのパネルのHTML", () => {
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

  /** 作者の指定（2026-08-29）「次に飛ばすのと戻る機能を付けてください」 */
  it("次へ・戻るのボタンがある", () => {
    expect(html).toContain('id="prev"');
    expect(html).toContain('id="next"');
    expect(html).toContain("← 戻る");
    expect(html).toContain("次へ →");
    expect(html).toContain('post("next")');
    expect(html).toContain('post("prev")');
  });

  it("絞り込みは、この話だけ・タグ・文字で探すの3つ", () => {
    expect(html).toContain('id="onlyCurrent"');
    expect(html).toContain('id="tag"');
    expect(html).toContain('id="query"');
    expect(html).toContain("この話だけ");
  });

  it("済みにするとMarkdown書き出しの口がある", () => {
    expect(html).toContain('post("done"');
    expect(html).toContain('post("export")');
  });

  /**
   * **作者の書いたものは必ず逃がす。** メモの文には引用符も `<` も入る。
   * 逃がさずに組み立てると、そこで画面が壊れる。
   */
  it("画面に出す値は escapeHtml を通す", () => {
    expect(html).toContain("function escapeHtml(");
    // 一覧の行の組み立てで、素の値を直に挟んでいないか
    const row = html.slice(html.indexOf("function renderRow("));
    const source = row.slice(0, row.indexOf("function render()"));
    expect(source).toContain("escapeHtml(row.text");
    expect(source).toContain("escapeHtml(row.tag)");
    expect(source).toContain("escapeHtml(row.key)");
  });

  /**
   * **色はCSS変数で受ける**（16進は `core/sceneMemo.ts` の1か所。6.40.5）。
   * 画面の中に色の値を書かない。
   */
  it("タグの色はCSS変数で受ける", () => {
    expect(html).toContain("var(--novelai-memo-todo");
    expect(html).toContain("var(--novelai-memo-check");
    expect(html).toContain("var(--novelai-memo-foreshadow");
    expect(html).toContain("var(--novelai-memo-idea");
    expect(html).toContain('"--novelai-" + key');
  });

  /** カーソルに追従して光る行（6.40.4）。**片方向**なので押す口は無い */
  it("いちばん近いメモを光らせる仕掛けがある", () => {
    expect(html).toContain(".memo.active");
    expect(html).toContain("data.activeKey");
  });

  /** 画面は数えない。届いた一覧を描くだけ（計算は拡張機能側） */
  it("画面は本文を読まない（拾い出しは拡張機能側）", () => {
    expect(html).not.toContain("parseMemos");
    expect(html).not.toContain("readTextFile");
  });

  /* ── AIの指摘を混ぜる（設計書6.96.5） ───────────────── */

  /**
   * 作者の指示（2026-09-19）「提案を種類にこだわらず、該当位置順で
   * まとめて並べる」。**指摘に付く口は2つだけ**——種類ごとの道へ渡す
   * 「直す」と、記録を足す「見送る」である。
   */
  it("AIの指摘には、直すと見送るの口がある", () => {
    expect(html).toContain('post("fix"');
    expect(html).toContain('post("dismissFinding"');
    expect(html).toContain("直す");
    expect(html).toContain("見送る");
  });

  /**
   * **画面は本文を直に書かない**（6.96.5・6.96.6）。［直す］は拡張機能へ頼むだけで、
   * 当てるのは提案パネルの［適用］と同じ関数である（作者の裁定 2026-10-03）。
   */
  it("画面に本文を書く処理は無い", () => {
    expect(html).not.toContain("writeTextFile");
    expect(html).not.toContain('post("apply"');
  });

  /**
   * 修正案があれば［直す］、無ければ［本文へ］（作者の裁定 2026-10-03・2026-10-04）。
   * ［本文へ］は行の場所を押したときと同じ「reveal」を送る（飛ぶ道を1本にする）。
   * ［提案へ］はやめた（「提案へ、というのもおかしい」）
   */
  it("直すと本文へは、拡張機能が決めた押し口で分かれ、［提案へ］は無い", () => {
    expect(html).toContain('row.fixAction === "apply"');
    expect(html).toContain('data-act="reveal"');
    expect(html).toContain(">本文へ</button>");
    expect(html).toContain('post("reveal", { filePath: row.filePath, line: row.line })');
    expect(html).not.toContain("提案へ");
    expect(html).not.toContain("handOver");
  });

  /** 修正案の無い推敲には［AIに相談］（作者の要望 2026-10-04）。口が無ければ出さない */
  it("［AIに相談］は拡張機能が許したときだけ出て、consult を送る", () => {
    expect(html).toContain("if (row.canConsult)");
    expect(html).toContain(">AIに相談</button>");
    expect(html).toContain('post("consult", { findingId: row.findingId })');
  });

  /** 提案パネルへ移る口は、上の帯に1つだけ。開く口が無ければ隠す */
  it("上に［提案パネル］が1つだけあり、開く口が無ければ隠れる", () => {
    expect(html.match(/>提案パネル<\/button>/g)).toHaveLength(1);
    expect(html).toContain('post("openProposals")');
    expect(html).toContain("el.openProposals.hidden = data.canOpenProposals !== true");
  });

  /** ［直す］で当てた指摘は一覧から消えるので、戻す口は一覧の外に置く */
  it("直した直近の1件を戻す帯がある", () => {
    expect(html).toContain('id="fixed"');
    expect(html).toContain('id="undoFix"');
    expect(html).toContain('post("undoFix")');
    expect(html).toContain("data.fixed");
  });

  /** **同じ行に複数来たら、その行にまとめて出す**（6.96.5） */
  it("同じ行の2件目からは、場所を繰り返さない", () => {
    expect(html).toContain("row.sameLine");
    expect(html).toContain("same-line");
  });

  /**
   * **指摘の印は1色**（種類で分けない。色の値は `core/sceneMemoRows.ts`）。
   * 分けたいのは「作者が書いたか、機械が挙げたか」だけである。
   */
  it("AIの指摘の色もCSS変数で受ける", () => {
    expect(html).toContain("var(--novelai-memo-ai");
  });
});
