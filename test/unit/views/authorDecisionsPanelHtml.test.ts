import { describe, expect, it } from "vitest";
import {
  buildAuthorDecisionsHtml,
  isOpenMessage,
  type AuthorDecisionRowHtml,
} from "../../../src/views/authorDecisionsPanelHtml";

/**
 * 編集者モードの「作者の採否」パネル（0.136.0。設計書5.7.5.9）の画面側の約束。
 *
 * 押して本文が開くか・パネルが閉じないかは画面でしか見えない（実機確認リスト）。
 * ここでは「行の中身が QuickPick のときと同じ言葉で出る」「本文の語を逃がす」
 * 「件数の見出し」「押したときに送る通信の形」「台本が JavaScript として読める」を見る。
 */

const rows: AuthorDecisionRowHtml[] = [
  {
    label: "採用　「彼わ」→「彼は」",
    description: "第1話.txt 12行",
    detail: "誤字脱字：助詞の誤り（11/07 10:00）・作者のひと言：ありがとう",
    kind: "accepted",
  },
  {
    label: "見送り　「<b>強調</b>」→「\"引用\" & 記号」",
    description: "第2話.txt 3行",
    detail: "表記：<script>alert(1)</script>",
    kind: "rejected",
  },
  {
    label: "読まれた　「冒頭」への意見",
    description: "第3話.txt 1行",
    detail: "意見：導入が長い",
    kind: "read",
  },
];

const html = buildAuthorDecisionsHtml(
  "NONCE123",
  "vscode-resource:",
  "作者の採否（採用 1・見送り 1・読まれた 1）",
  rows
);
const script = html.slice(
  html.indexOf(">", html.indexOf('<script nonce="NONCE123">')) + 1,
  html.lastIndexOf("</script>")
);

describe("作者の採否のパネル", () => {
  it("件数の見出しを上に出す", () => {
    expect(html).toContain("<h1>作者の採否（採用 1・見送り 1・読まれた 1）</h1>");
  });

  it("行ごとに印・語・ファイル名と行・理由と時刻とひと言を出し、押せる番号を持たせる", () => {
    expect(html).toContain('data-index="0"');
    expect(html).toContain('data-index="2"');
    expect(html).toContain("採用　「彼わ」→「彼は」");
    expect(html).toContain("第1話.txt 12行");
    expect(html).toContain("誤字脱字：助詞の誤り（11/07 10:00）・作者のひと言：ありがとう");
    expect(html).toContain("読まれた　「冒頭」への意見");
    // 色分けの種類
    expect(html).toContain('class="row accepted"');
    expect(html).toContain('class="row rejected"');
    expect(html).toContain('class="row read"');
  });

  it("本文の語とひと言は逃がしてから入れる（生のタグにしない）", () => {
    expect(html).toContain("「&lt;b&gt;強調&lt;/b&gt;」→「&quot;引用&quot; &amp; 記号」");
    expect(html).toContain("表記：&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<b>強調</b>");
    expect(html).not.toContain("<script>alert(1)</script>");
    // 台本は1本だけ（本文から台本が紛れ込んでいない）
    expect(html.split("<script").length - 1).toBe(1);
  });

  it("見出しも逃がす", () => {
    const tricky = buildAuthorDecisionsHtml("N", "c", "作者の採否（<i>）", rows);
    expect(tricky).toContain("<h1>作者の採否（&lt;i&gt;）</h1>");
  });

  it("押したら行の番号を送る（語そのものは送らない）", () => {
    expect(script).toContain('vscode.postMessage({ type: "open", index: index })');
    expect(script).toContain('getAttribute("data-index")');
  });

  it("台本が JavaScript として読める", () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it("画面から外へは繋がない（CSP に nonce・fetch を使わない）", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
    expect(html).not.toContain("connect-src");
    expect(script).not.toContain("fetch(");
  });

  it("色はテーマの変数を使い、幅が狭くても横へはみ出さない", () => {
    expect(html).toContain("var(--vscode-foreground)");
    expect(html).toContain("var(--vscode-editor-background)");
    expect(html).toContain("overflow-x: hidden");
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).toContain("box-sizing: border-box");
  });
});

describe("届いた通信の確かめ", () => {
  it("行を押した通信だけを通す", () => {
    expect(isOpenMessage({ type: "open", index: 0 })).toBe(true);
    expect(isOpenMessage({ type: "open", index: 3 })).toBe(true);
  });

  it("形の違うものは通さない", () => {
    expect(isOpenMessage(null)).toBe(false);
    expect(isOpenMessage("open")).toBe(false);
    expect(isOpenMessage({ type: "open" })).toBe(false);
    expect(isOpenMessage({ type: "open", index: "1" })).toBe(false);
    expect(isOpenMessage({ type: "open", index: -1 })).toBe(false);
    expect(isOpenMessage({ type: "open", index: 1.5 })).toBe(false);
    expect(isOpenMessage({ type: "ready", index: 0 })).toBe(false);
  });
});
