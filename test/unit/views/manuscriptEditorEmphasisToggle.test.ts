import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";
import { NOTATION_RULES } from "../../../src/core/manuscriptRender";
import { findEmphasisSpans } from "../../../src/core/ruby";

/**
 * 原稿エディターの傍点の付け外し（作者の裁定、2026-10-03。設計書6.34.2）。
 *
 * - 傍点の付いた所を選んで［傍点］（Ctrl+Alt+K）を押すと外れる
 * - 傍点の上で右クリックすると、品書きの「傍点付与」が「傍点消去」に変わる
 *
 * 画面へ渡る本物のスクリプトを切り出して動かす（manuscriptEditorClipboardMenu.test.ts と同じやり方）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

function functionSource(name: string, until: string): string {
  const start = code.indexOf(`function ${name}(`);
  const end = code.indexOf(until, start);
  expect(start, `${name} が見つからない`).toBeGreaterThan(0);
  expect(end, `${name} の終わりが見つからない`).toBeGreaterThan(start);
  return code.slice(start, end);
}

interface MenuItem {
  kind: "item" | "rule";
  label: string;
  disabled: boolean;
  click?: () => void;
}

function runOpenMenu(emphasisOn: { start: number; end: number } | null): {
  items: MenuItem[];
  posted: unknown[];
} {
  const source = functionSource("openMenu", "function termAtCaret(");
  const env = { items: [] as MenuItem[], posted: [] as unknown[] };
  const openMenu = new Function(
    "env",
    `
    const composeOn = false;
    const composeMenuAt = null;
    const write = { selectionStart: 0, selectionEnd: 0 };
    const vscode = { postMessage(message) { env.posted.push(message); } };
    const window = { innerWidth: 1000, innerHeight: 1000 };
    let menuTerm = null;
    function closeMenu() {}
    function menuCut() {}
    function menuCopy() {}
    function menuPaste() {}
    function askRuby() {}
    function askEmphasis() { env.posted.push("付ける"); }
    function askEmphasisOff(range) {
      vscode.postMessage({ type: "emphasis", text: "", start: range.start, end: range.end });
    }
    function menuSelection() { return null; }
    function menuCaretLine() { return 0; }
    function menuSelectedNotation() { return ""; }
    const menu = {
      set innerHTML(value) { env.items.length = 0; },
      classList: { add() {} },
      style: {},
      getBoundingClientRect() { return { width: 10, height: 10 }; },
      appendChild(node) { env.items.push(node.item); },
    };
    const document = {
      createElement() {
        const item = { kind: "item", label: "", disabled: false };
        const node = {
          item,
          set className(value) {
            if (value === "rule") item.kind = "rule";
            item.disabled = value.indexOf("disabled") >= 0;
          },
          set textContent(value) { item.label = value; },
          addEventListener(type, fn) { if (type === "click") item.click = fn; },
        };
        return node;
      },
    };
    ${source}
    return openMenu;
    `
  )(env) as (
    x: number,
    y: number,
    term: unknown,
    hasSelection: boolean,
    emphasisOn: unknown
  ) => void;
  openMenu(0, 0, null, false, emphasisOn);
  return env;
}

describe("右クリックの品書き：傍点の上では「傍点消去」", () => {
  it("傍点の上なら「傍点消去」が出て、選んでいなくても押せる。押すと傍点の範囲で外す頼みが行く", () => {
    const { items, posted } = runOpenMenu({ start: 2, end: 8 });
    const labels = items.map((item) => item.label);
    expect(labels).toContain("傍点消去");
    expect(labels).not.toContain("傍点付与");

    const off = items.find((item) => item.label === "傍点消去");
    expect(off?.disabled).toBe(false);
    off?.click?.();
    expect(posted).toEqual([{ type: "emphasis", text: "", start: 2, end: 8 }]);
  });

  it("傍点の無い所では「傍点付与」のまま（選んでいなければ押せない）", () => {
    const { items } = runOpenMenu(null);
    const labels = items.map((item) => item.label);
    expect(labels).toContain("傍点付与");
    expect(labels).not.toContain("傍点消去");
    expect(items.find((item) => item.label === "傍点付与")?.disabled).toBe(true);
  });
});

/** 画面側の判定（emphasisRangeIn）を、記法の規則つきで取り出す */
function emphasisRangeIn(
  mode: "curly" | "site"
): (text: string, start: number, end: number) => { start: number; end: number } | null {
  const source = functionSource("emphasisRangeIn", "function emphasisTarget(");
  return new Function(
    `
    const COMPOSE_NOTATION_RULES = ${JSON.stringify(NOTATION_RULES)};
    const composeNotation = ${JSON.stringify(mode)};
    function composeRules(name) { return COMPOSE_NOTATION_RULES[name]; }
    ${source}
    return emphasisRangeIn;
    `
  )() as (text: string, start: number, end: number) => { start: number; end: number } | null;
}

/**
 * **画面と拡張機能で答えを揃える。** 画面が「外す頼み」を出したのに拡張機能が
 * 傍点を見つけられないと、付ける道へ進んで記法が入れ子になる（逆なら外れない）。
 */
describe("画面の傍点の判定は、拡張機能（findEmphasisSpans）と同じ答え", () => {
  const cases: Array<{ mode: "curly" | "site"; text: string; start: number; end: number }> = [
    { mode: "curly", text: "あの{{とき}}は", start: 2, end: 8 },
    { mode: "curly", text: "あの{{とき}}は", start: 4, end: 5 },
    { mode: "curly", text: "あの{{とき}}は", start: 0, end: 5 },
    { mode: "curly", text: "あの{{とき}}は", start: 0, end: 2 },
    { mode: "curly", text: "あの{{とき}}は", start: 8, end: 8 },
    { mode: "curly", text: "あの{{とき}}は", start: 1, end: 1 },
    { mode: "curly", text: "{漢字|かんじ}", start: 0, end: 9 },
    { mode: "curly", text: "{{あ}}と{{い}}", start: 0, end: 11 },
    { mode: "site", text: "あの《《とき》》は", start: 4, end: 5 },
    { mode: "site", text: "{{とき}}", start: 0, end: 6 },
    { mode: "curly", text: "《《とき》》", start: 0, end: 6 },
  ];
  for (const sample of cases) {
    it(`${sample.mode}：「${sample.text}」の ${sample.start}〜${sample.end}`, () => {
      const page = emphasisRangeIn(sample.mode)(sample.text, sample.start, sample.end);
      const spans = findEmphasisSpans(sample.text, sample.start, sample.end, sample.mode);
      const expected =
        spans.length === 0
          ? null
          : { start: spans[0].start, end: spans[spans.length - 1].end };
      expect(page).toEqual(expected);
    });
  }
});

describe("［傍点］ボタン・Ctrl+Alt+K は付け外しの切り替え", () => {
  function runAskEmphasis(on: { start: number; end: number } | null): unknown[] {
    const source = functionSource("askEmphasis", "/* ── 打たれたら");
    const posted: unknown[] = [];
    const askEmphasis = new Function(
      "posted",
      "on",
      `
      const composeOn = false;
      const write = { selectionStart: 3, selectionEnd: 5 };
      const vscode = { postMessage(message) { posted.push(message); } };
      function emphasisTarget() { return on; }
      function askEmphasisOff(range) {
        vscode.postMessage({ type: "emphasis", text: "", start: range.start, end: range.end });
      }
      function composeAskNotation() { posted.push("組んで書く面"); }
      function selectionText() { return "とき"; }
      ${source}
      return askEmphasis;
      `
    )(posted, on) as () => void;
    askEmphasis();
    return posted;
  }

  it("傍点が掛かっていれば、外す頼み（傍点の範囲）を出す", () => {
    expect(runAskEmphasis({ start: 2, end: 8 })).toEqual([
      { type: "emphasis", text: "", start: 2, end: 8 },
    ]);
  });

  it("掛かっていなければ、これまでどおり付ける頼みを出す", () => {
    expect(runAskEmphasis(null)).toEqual([
      { type: "emphasis", text: "とき", start: 3, end: 5 },
    ]);
  });
});
