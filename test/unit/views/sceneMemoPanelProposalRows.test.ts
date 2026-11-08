import { describe, expect, it } from "vitest";
import { buildSceneMemoPanelHtml } from "../../../src/views/sceneMemoPanelHtml";

/**
 * 校正・メモパネルの、編集者の提案の行の押し口（作者の指示 2026-11-08
 * 「編集からの提案も校正メモにうつしてください」。設計書6.96.5）。
 *
 * 画面の関数（`renderActions`・`renderRow`）を切り出して実際に組ませ、出てくる
 * HTML を見る（`sceneMemoPanelAdvice.test.ts` と同じ作り）。
 */

const html = buildSceneMemoPanelHtml("NONCE123", "vscode-resource:");
const script = html.slice(html.indexOf("<script"), html.indexOf("</script>"));

function sliceFn(name: string, next: string): string {
  const start = script.indexOf(`function ${name}(`);
  const end = script.indexOf(`function ${next}(`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

function makeRenderRow(): (row: Record<string, unknown>) => string {
  const escape = sliceFn("escapeHtml", "sendFilter").split("el.prev.addEventListener")[0];
  const source = [
    escape,
    sliceFn("renderActions", "renderAdvice"),
    sliceFn("renderAdvice", "renderRow"),
    sliceFn("renderRow", "render"),
  ].join("\n");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function("data", `${source}\nreturn renderRow;`) as (data: {
    activeKey: string;
  }) => (row: Record<string, unknown>) => string;
  return make({ activeKey: "" });
}

const fixRow = {
  kind: "proposal",
  key: "p:p1",
  proposalId: "p1",
  filePath: "C:/a/001.txt",
  line: 3,
  sameLine: false,
  tag: "編集者の提案",
  tagClass: "finding-editorProposal",
  text: "「明けた」→「明けてゆく」",
  note: "時の流れを見せたい（kmizu の提案）",
  chapterLabel: "第1話",
  title: "",
  proposalAction: "accept",
};

describe("編集者の提案の行", () => {
  const renderRow = makeRenderRow();

  it("直しの提案は［採る］と［見送る］（AIの指摘の［直す］とは別の用件）", () => {
    const out = renderRow(fixRow);
    expect(out).toContain('data-act="proposalAccept"');
    expect(out).toContain(">採る</button>");
    expect(out).toContain('data-act="proposalReject"');
    expect(out).toContain(">見送る</button>");
    expect(out).not.toContain('data-act="fix"');
    expect(out).not.toContain('data-act="dismiss"');
    // 添え書き（kmizu の提案）も行に出る
    expect(out).toContain("（kmizu の提案）");
  });

  it("意見は［読んだ］［本文へ］［見送る］（提案パネルの［読んだ］と同じ）", () => {
    const out = renderRow({ ...fixRow, proposalAction: "read", text: "ここは間が長い" });
    expect(out).toContain(">読んだ</button>");
    expect(out).toContain('data-act="reveal"');
    expect(out).toContain(">見送る</button>");
    expect(out).not.toContain(">採る</button>");
  });

  it("決める口が無ければ押し口を出さない", () => {
    const out = renderRow({ ...fixRow, proposalAction: null });
    expect(out).not.toContain("proposalAccept");
    expect(out).not.toContain("proposalReject");
  });

  it("押すと decideProposal を、accept／reject で送る", () => {
    expect(script).toContain('post("decideProposal"');
    expect(script).toContain('act === "proposalAccept" ? "accept" : "reject"');
  });
});
