import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 行へ飛んだときのカーソルと光り（作者の裁定、2026-10-03。設計書6.25.11）。
 *
 * F8／Shift+F8 や、校正・メモパネル・提案パネルの行から原稿エディターの行へ
 * 飛ぶと、**その行が丸ごと選ばれた状態**になっていた。そのまま打つと、
 * メモの行や本文の1行が打った字に置き換わる。
 *
 * - 飛んだら**行の頭にカーソルだけ置く**（選ばない）
 * - 飛んだ行を**しばらく光らせて**、どこへ飛んだかを見せる（数秒で消える）
 *
 * 画面へ渡る本物のスクリプト（revealLine の区切り）を切り出して、
 * 作り物の面の上で動かす（manuscriptEditorSave.test.ts と同じやり方）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

function markedBlock(name: string): string {
  const start = code.indexOf(`/* ${name}:start */`);
  const end = code.indexOf(`/* ${name}:end */`);
  if (start < 0 || end < 0) return "";
  return code.slice(start, end);
}

interface FakeNode {
  className?: string;
  textContent: string;
}

interface Env {
  text: string;
  composeOn: boolean;
  aloudOn: boolean;
  findIsOpen: boolean;
  selections: Array<[number, number]>;
  composeCarets: Array<{ start: number; end: number }>;
  marks: FakeNode[];
  bodyClasses: Set<string>;
  highlights: Map<string, unknown>;
  listeners: Record<string, Array<() => void>>;
  now: number;
  timers: Array<{ at: number; fn: () => void; id: number }>;
  nextId: number;
}

function harness(options: { composeOn?: boolean; text?: string } = {}) {
  const block = markedBlock("revealLine");
  expect(block, "行へ飛ぶ仕組み（revealLine の区切り）が画面に無い").not.toBe("");
  const env: Env = {
    text: options.text ?? "一行目\n二行目の文\n三行目",
    composeOn: options.composeOn ?? false,
    aloudOn: false,
    findIsOpen: false,
    selections: [],
    composeCarets: [],
    marks: [],
    bodyClasses: new Set(),
    highlights: new Map(),
    listeners: {},
    now: 0,
    timers: [],
    nextId: 1,
  };
  const api = new Function(
    "env",
    `
    const vscode = { postMessage: () => {} };
    function listen(owner) {
      return (type, fn) => {
        const key = owner + ":" + type;
        (env.listeners[key] = env.listeners[key] || []).push(fn);
      };
    }
    const write = {
      get value() { return env.text; },
      focus() {},
      blur() {},
      setSelectionRange(a, b) { env.selections.push([a, b]); },
      addEventListener: listen("write"),
    };
    const compose = { focus() {}, addEventListener: listen("compose") };
    const aloudMarks = {
      get firstChild() { return env.marks[0] || null; },
      removeChild(node) { env.marks.splice(env.marks.indexOf(node), 1); node.parentNode = null; },
      appendChild(node) { env.marks.push(node); node.parentNode = aloudMarks; },
    };
    const document = {
      body: {
        classList: {
          add: (name) => env.bodyClasses.add(name),
          remove: (name) => env.bodyClasses.delete(name),
          contains: (name) => env.bodyClasses.has(name),
        },
      },
      createElement: () => ({ className: "", textContent: "" }),
      createTextNode: (text) => ({ textContent: text }),
      createRange: () => ({ setStart() {}, setEnd() {} }),
    };
    class Highlight { constructor(range) { this.range = range; } }
    const CSS = {
      highlights: {
        set: (name, value) => env.highlights.set(name, value),
        delete: (name) => env.highlights.delete(name),
        get: (name) => env.highlights.get(name),
      },
    };
    function setTimeout(fn, ms) {
      const id = env.nextId++;
      env.timers.push({ at: env.now + (ms || 0), fn, id });
      return id;
    }
    function clearTimeout(id) {
      env.timers = env.timers.filter((timer) => timer.id !== id);
    }
    let composeOn = env.composeOn;
    function composeRestoreCaret(at) { env.composeCarets.push({ start: at.start, end: at.end }); }
    function composeNudgeIntoView() { return true; }
    function composeHighlightsUsable() { return true; }
    function composeCurrentAtoms() { return []; }
    function composeOffsetToPoint(atoms, offset) { return { node: {}, offset }; }
    function alignMarksBox() {}
    function syncMarksScroll() {}
    function aloudNudgeWriteIntoView() {}
    function aloudClearWriteMark() {
      while (aloudMarks.firstChild) aloudMarks.removeChild(aloudMarks.firstChild);
    }
    const state = {
      get aloudOn() { return env.aloudOn; },
      get findIsOpen() { return env.findIsOpen; },
    };
    ${block.replace(/\baloudOn\b/g, "state.aloudOn").replace(/\bfindIsOpen\b/g, "state.findIsOpen")}
    return { revealLine };
    `
  )(env) as { revealLine(line: number, caret?: string): void };

  return {
    env,
    revealLine: (line: number, caret?: string) => api.revealLine(line, caret),
    advance(ms: number) {
      const until = env.now + ms;
      for (;;) {
        env.timers.sort((a, b) => a.at - b.at);
        const next = env.timers[0];
        if (!next || next.at > until) break;
        env.timers.shift();
        env.now = next.at;
        next.fn();
      }
      env.now = until;
    },
    fire(owner: string, type: string) {
      for (const fn of env.listeners[`${owner}:${type}`] ?? []) fn();
    },
    flashText(): string | undefined {
      return env.marks.find((node) => node.className === "mark-reveal")?.textContent;
    },
  };
}

describe("打つ面（textarea）で行へ飛ぶ", () => {
  it("行の頭にカーソルだけ置く（選ばない）", () => {
    const h = harness();
    h.revealLine(2);
    // 「一行目\n」の4字のあとが2行目の頭
    expect(h.env.selections.at(-1)).toEqual([4, 4]);
    for (const [start, end] of h.env.selections) expect(end).toBe(start);
  });

  it("飛んだ行をしばらく光らせ、数秒で消す", () => {
    const h = harness();
    h.revealLine(2);
    expect(h.flashText()).toBe("二行目の文");
    expect(h.env.bodyClasses.has("revealmark")).toBe(true);

    h.advance(1000);
    expect(h.flashText()).toBe("二行目の文");

    h.advance(5000);
    expect(h.flashText()).toBeUndefined();
    expect(h.env.bodyClasses.has("revealmark")).toBe(false);
  });

  it("打ち始めたら光りを消す（字がずれた塗りを残さない）", () => {
    const h = harness();
    h.revealLine(2);
    h.fire("write", "input");
    expect(h.flashText()).toBeUndefined();
    expect(h.env.bodyClasses.has("revealmark")).toBe(false);
  });

  it("続けて飛んだら、前の光りは新しい行へ移る", () => {
    const h = harness();
    h.revealLine(2);
    h.advance(1500);
    h.revealLine(3);
    expect(h.flashText()).toBe("三行目");
    // 前の時計で、新しい光りまで消さない
    h.advance(1500);
    expect(h.flashText()).toBe("三行目");
  });

  it("読み上げ・探すの塗りがあるあいだは、その層を借りない", () => {
    const h = harness();
    h.env.aloudOn = true;
    h.revealLine(2);
    expect(h.env.selections.at(-1)).toEqual([4, 4]);
    expect(h.flashText()).toBeUndefined();

    h.env.aloudOn = false;
    h.env.findIsOpen = true;
    h.revealLine(3);
    expect(h.flashText()).toBeUndefined();
  });

  it("光っているあいだに読み上げが層を塗り替えたら、時計が来てもその色を消さない", () => {
    const h = harness();
    h.revealLine(2);
    // 読み上げが層を塗り替える（aloudPaintWriteMark と同じ：中身を全部入れ替える）
    while (h.env.marks.length > 0) {
      const node = h.env.marks.pop() as FakeNode & { parentNode?: unknown };
      node.parentNode = null;
    }
    h.env.marks.push({ className: "mark-reading", textContent: "読んでいる文" });
    h.advance(6000);
    expect(h.env.marks.some((node) => node.className === "mark-reading")).toBe(true);
  });

  it("末尾を頼まれたら（メモを足した直後）、行の末尾にカーソルを置く", () => {
    const h = harness({ text: "一行目\n// \n二行目" });
    h.revealLine(2, "end");
    expect(h.env.selections.at(-1)).toEqual([7, 7]);
  });

  it("本文より先の行を指されても、末尾で止まる", () => {
    const h = harness();
    h.revealLine(99);
    const length = h.env.text.length;
    expect(h.env.selections.at(-1)).toEqual([length, length]);
  });
});

describe("組んで書く面で行へ飛ぶ", () => {
  it("行の頭にカーソルだけ置く（選ばない）", () => {
    const h = harness({ composeOn: true });
    h.revealLine(2);
    expect(h.env.composeCarets.at(-1)).toEqual({ start: 4, end: 4 });
  });

  it("飛んだ行をしばらく光らせ、数秒で消す", () => {
    const h = harness({ composeOn: true });
    h.revealLine(2);
    expect(h.env.highlights.has("novelai-reveal")).toBe(true);
    h.advance(6000);
    expect(h.env.highlights.has("novelai-reveal")).toBe(false);
  });

  it("打ち始めたら光りを消す", () => {
    const h = harness({ composeOn: true });
    h.revealLine(2);
    h.fire("compose", "input");
    expect(h.env.highlights.has("novelai-reveal")).toBe(false);
  });
});

describe("受け口と色", () => {
  it("拡張機能から届いたカーソルの置き場（頭／末尾）を渡す", () => {
    expect(code).toContain("revealLine(message.line, message.caret)");
  });

  it("光りの色はテーマの色から取り、組んで書く面の規則は単独で書く", () => {
    const css = html.slice(0, html.indexOf("<script"));
    expect(css).toMatch(/#aloudmarks \.mark-reveal \{[^}]*var\(--vscode-/);
    // ::highlight を知らない環境で、ほかの選択子まで捨てられないように
    expect(css).toMatch(/\n::highlight\(novelai-reveal\) \{[^}]*var\(--vscode-/);
    expect(css).toContain("body.revealmark:not(.compose):not(.notepv) #aloudmarks");
  });
});
