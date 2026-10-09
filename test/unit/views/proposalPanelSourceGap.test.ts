import { describe, expect, test } from "vitest";
import { buildProposalPanelHtml } from "../../../src/views/proposalPanelHtml";

/**
 * 提案パネルの見出しで、名前と出どころの間に区切りを入れる（作者の裁定、2026-10-10）。
 *
 * 「葛西 湊プロットから：新規の人物」と、名前と「プロットから」がくっついて
 * 読めなかった（`<span>` を2つ並べただけで、間に何も無かったため）。
 * 描画はWebViewの中で動くので、組み上がったHTMLから関数を取り出して走らせる。
 */
const html = buildProposalPanelHtml("test-nonce", "vscode-webview:");

function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  for (let i = head; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      started = true;
    } else if (source[i] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, i + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

const renderRecordUpdate = new Function(
  [
    extractFunction(html, "escapeHtml"),
    "function renderRecordChanges() { return ''; }",
    "function canApplyRecordUpdate() { return true; }",
    extractFunction(html, "doneLabel"),
    extractFunction(html, "renderRecordUpdate"),
    "return renderRecordUpdate;",
  ].join("\n")
)() as (item: unknown) => string;

describe("名前と出どころの間の区切り", () => {
  test("見出しの文字を並べたとき、名前と出どころが離れている", () => {
    const out = renderRecordUpdate({
      id: "p1",
      name: "葛西 湊",
      source: "プロットから：新規の人物",
      status: "pending",
    });
    const heading = out
      .match(/<div class="meta">([\s\S]*?)<\/div>/)![1]
      .replace(/<[^>]*>/g, "");
    expect(heading).not.toContain("湊プロットから");
    expect(heading).toContain("湊　プロットから：新規の人物");
  });
});
