import { describe, expect, test } from "vitest";
import { buildSettingsPanelHtml } from "../../../src/views/settingsPanelHtml";

/**
 * 設定資料パネルの「反映待ちの更新が N 件あります」（作者の依頼、2026-09-23 ⑥）。
 *
 * パネルには更新分の反映の入口が無く、承認待ちが溜まっていても
 * 詳細メニューの印を見に行かないと気づけなかった。
 *
 * **配線は目で見ても抜けに気づけない**（「ルビを追加」で、ボタンもスタイルも
 * 受け側もあるのにクリックの登録だけが無かった）。押したら拡張側へ届くところと、
 * 件数を受け取ったら出る・0件なら隠れるところまでを機械に見張らせる。
 */

const HTML = buildSettingsPanelHtml("test-nonce", "vscode-resource:");

function script(): string {
  const found = HTML.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
  expect(found, "スクリプトが見つからない").toBeTruthy();
  return found![1];
}

interface StubElement {
  id: string;
  listeners: Map<string, Array<() => void>>;
  addEventListener(type: string, handler: () => void): void;
  hidden: boolean;
  textContent: string;
  [key: string]: unknown;
}

function makeElement(id: string): StubElement {
  const listeners = new Map<string, Array<() => void>>();
  return {
    id,
    listeners,
    hidden: false,
    textContent: "",
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
    innerHTML: "",
    value: "",
    style: {},
    dataset: {},
  };
}

function runScript(): {
  elements: Map<string, StubElement>;
  posted: Array<Record<string, unknown>>;
  deliver: (message: unknown) => void;
} {
  const elements = new Map<string, StubElement>();
  const posted: Array<Record<string, unknown>> = [];
  const windowListeners: Array<(event: { data: unknown }) => void> = [];

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
  const win = {
    addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
      if (type === "message") windowListeners.push(handler);
    },
    innerWidth: 800,
  };
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
  ) as (doc: unknown, win: unknown, api: unknown) => void;
  run(document, win, acquireVsCodeApi);

  return {
    elements,
    posted,
    deliver: (message) => {
      for (const listener of windowListeners) listener({ data: message });
    },
  };
}

const EMPTY_GROUPS = {
  character: [],
  ability: [],
  organization: [],
  location: [],
  world: [],
};

describe("反映待ちの更新の入口", () => {
  test("入口の要素がある（最初は隠しておく）", () => {
    expect(HTML).toContain('id="pending-updates"');
    expect(HTML).toMatch(/id="pending-updates"[^>]*hidden/);
  });

  test("件数を受け取ると文を出し、0件なら隠す", () => {
    const { elements, deliver } = runScript();
    const box = elements.get("pending-updates");
    const text = elements.get("pending-updates-text");
    expect(box, "pending-updates を取っていない").toBeTruthy();

    deliver({
      type: "init",
      groups: EMPTY_GROUPS,
      pendingUpdates: "反映待ちの更新が 4 件あります（人物 3・場所 1）",
    });
    expect(box!.hidden).toBe(false);
    expect(text!.textContent).toBe(
      "反映待ちの更新が 4 件あります（人物 3・場所 1）"
    );

    deliver({ type: "init", groups: EMPTY_GROUPS, pendingUpdates: "" });
    expect(box!.hidden).toBe(true);
  });

  test("押すと openPendingUpdates が拡張側へ届く", () => {
    const { elements, posted } = runScript();
    const button = elements.get("pending-updates-open");
    expect(button, "pending-updates-open を取っていない").toBeTruthy();
    const clicks = button!.listeners.get("click") ?? [];
    expect(clicks).toHaveLength(1);

    posted.length = 0;
    clicks[0]();
    expect(posted).toEqual([{ type: "openPendingUpdates" }]);
  });
});
