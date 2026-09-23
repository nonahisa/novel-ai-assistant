import { describe, expect, test } from "vitest";
import { buildSettingsPanelHtml } from "../../src/views/settingsPanelHtml";

/**
 * 設定資料パネルの「ルビを追加」（設計書6.12.5。実機確認 2026-09-06）。
 *
 * ボタンのHTMLもスタイルも受け側（`settingsPanel.ts` の `case "applyRuby"`）も
 * あったのに、**画面側のクリックの登録だけが無かった**。押しても話を選ぶ画面が
 * 出ず、通知もログも出ず、本文も変わらない——作者からは「壊れている」としか
 * 見えないうえ、この節の実機確認15項目すべてが実行できなくなっていた。
 *
 * **配線は目で見ても抜けに気づけない**（HTMLとスタイルがあるので「実装済み」に
 * 見える）ので、押したら本当に伝わるところまでを機械に見張らせる。
 */

const HTML = buildSettingsPanelHtml("test-nonce", "vscode-resource:");

function script(): string {
  const found = HTML.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
  expect(found, "スクリプトが見つからない").toBeTruthy();
  return found![1];
}

/** クリックの登録を覚える、最小限の代役の要素 */
interface StubElement {
  id: string;
  listeners: Map<string, Array<() => void>>;
  addEventListener(type: string, handler: () => void): void;
  classList: { toggle(): void; add(): void; remove(): void; contains(): boolean };
  [key: string]: unknown;
}

function makeElement(id: string): StubElement {
  const listeners = new Map<string, Array<() => void>>();
  const element: StubElement = {
    id,
    listeners,
    addEventListener(type: string, handler: () => void): void {
      const found = listeners.get(type) ?? [];
      found.push(handler);
      listeners.set(type, found);
    },
    classList: {
      toggle: () => undefined,
      add: () => undefined,
      remove: () => undefined,
      contains: () => false,
    },
    appendChild: () => undefined,
    replaceChildren: () => undefined,
    querySelectorAll: () => [],
    querySelector: () => undefined,
    focus: () => undefined,
    setAttribute: () => undefined,
    textContent: "",
    innerHTML: "",
    value: "",
    style: {},
    dataset: {},
  };
  return element;
}

/**
 * 画面側のスクリプトを、代役のDOMの上で走らせる。
 *
 * **本物のブラウザは要らない。** 見たいのは「どの要素に、どの用件を送る
 * クリックが付いたか」だけである。
 */
function runScript(): {
  elements: Map<string, StubElement>;
  posted: Array<Record<string, unknown>>;
} {
  const elements = new Map<string, StubElement>();
  const posted: Array<Record<string, unknown>> = [];

  const document = {
    getElementById(id: string): StubElement {
      const found = elements.get(id) ?? makeElement(id);
      elements.set(id, found);
      return found;
    },
    createElement: (tag: string) => makeElement(tag),
    createTextNode: () => makeElement("#text"),
    body: makeElement("body"),
    addEventListener: () => undefined,
  };
  const win = { addEventListener: () => undefined, innerWidth: 800 };
  const acquireVsCodeApi = () => ({
    postMessage: (message: Record<string, unknown>) => {
      posted.push(message);
    },
    getState: () => undefined,
    setState: () => undefined,
  });

  const run = new Function(
    "document",
    "window",
    "acquireVsCodeApi",
    script()
  ) as (
    doc: unknown,
    win: unknown,
    api: unknown
  ) => void;
  run(document, win, acquireVsCodeApi);

  return { elements, posted };
}

describe("「ルビを追加」の配線", () => {
  test("ボタンがある", () => {
    expect(HTML).toContain('id="apply-ruby"');
  });

  test("押すと applyRuby が拡張側へ届く", () => {
    const { elements, posted } = runScript();
    const button = elements.get("apply-ruby");

    // **ここが抜けていた。** 要素は取れるのに、クリックが1つも付いていなかった
    expect(button, "apply-ruby を取っていない").toBeTruthy();
    const clicks = button!.listeners.get("click") ?? [];
    expect(clicks).toHaveLength(1);

    posted.length = 0;
    clicks[0]();

    expect(posted).toEqual([{ type: "applyRuby" }]);
  });
});
