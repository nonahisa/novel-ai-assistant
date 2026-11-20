import { describe, expect, test } from "vitest";
import { buildEditHistoryHtml } from "../../../src/views/editHistoryPanelHtml";
import { ACTOR_KINDS } from "../../../src/models/actor";

/**
 * 編集履歴の画面（`views/editHistoryPanelHtml.ts`）の台本が、受け取った値を
 * HTML として解釈させない（セキュリティ点検 2026-11-21）。
 *
 * 履歴は同期され、編集部の写しからも届く（設計書5.6.3）。台本の `escapeHtml` は
 * `"` と `'` を逃がしておらず、`entry.actor` は class 属性へそのまま入っていた。
 *
 * 台本は WebView の中で動くので、ここでは画面の部品を作り物で差し替えて、
 * 製品と同じ台本の文字列をそのまま走らせる（`keyLabels.test.ts` と同じ形）。
 */

function scriptOf(): string {
  const html = buildEditHistoryHtml("nonce", "csp");
  const match = /<script nonce="nonce">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("台本が見つかりません");
  return match[1];
}

interface FakeElement {
  innerHTML: string;
  textContent: string;
  className: string;
  addEventListener: () => void;
}

function runPanel(entries: unknown[]): { list: FakeElement; escape: (text: unknown) => string } {
  const elements = new Map<string, FakeElement>();
  const element = (id: string): FakeElement => {
    let found = elements.get(id);
    if (!found) {
      found = { innerHTML: "", textContent: "", className: "", addEventListener: () => {} };
      elements.set(id, found);
    }
    return found;
  };
  const checkboxes = ACTOR_KINDS.map((kind) => ({ checked: true, dataset: { kind } }));
  const document = {
    getElementById: element,
    querySelectorAll: () => checkboxes,
  };
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  const window = {
    addEventListener: (type: string, callback: (event: { data: unknown }) => void) => {
      if (type === "message") onMessage = callback;
    },
  };
  const acquireVsCodeApi = () => ({ postMessage: () => {} });
  const escape = new Function(
    "document",
    "window",
    "acquireVsCodeApi",
    `${scriptOf()}\nreturn escapeHtml;`
  )(document, window, acquireVsCodeApi) as (text: unknown) => string;
  onMessage?.({ data: { type: "history", entries, external: [] } });
  return { list: element("list"), escape };
}

describe("編集履歴の画面は、届いた値を HTML として読ませない", () => {
  test("escapeHtml は引用符も逃がす（属性の中に入っても抜けない）", () => {
    const { escape } = runPanel([]);
    expect(escape(`"x' onmouseover='y"`)).toBe("&quot;x&#39; onmouseover=&#39;y&quot;");
    expect(escape("<b>&")).toBe("&lt;b&gt;&amp;");
  });

  test("決まった値でない actor の行は出さない（class 属性へ入れない）", () => {
    const { list } = runPanel([
      { actor: 'author" onclick="alert(1)', action: "書いた", time: "2026-11-21T00:00:00Z" },
      { actor: "constructor", action: "書いた", time: "2026-11-21T00:00:00Z" },
      { actor: "editor", action: "直した", time: "2026-11-21T00:00:00Z" },
    ]);
    expect(list.innerHTML).not.toContain("onclick");
    expect(list.innerHTML).not.toContain("constructor");
    expect(list.innerHTML).toContain('class="entry editor"');
  });
});
