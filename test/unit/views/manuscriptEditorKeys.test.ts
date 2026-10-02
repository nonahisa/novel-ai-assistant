import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 原稿エディターのキー操作（作者の裁定、2026-10-02。設計書6.25）。
 *
 * - Ctrl+F … 本文を探す（自前の検索の列。打つ面・組んで書く面の両方）
 * - Alt+↑／Alt+↓ … 前の話・次の話（キーからは新しい話を作らない）
 * - Ctrl+Shift+R … ルビ／Ctrl+Shift+K … 傍点
 * - Ctrl+ホイール・Ctrl+＋／Ctrl+－・Ctrl+0 … 本文の字の大きさ
 *
 * 画面へ渡る本物のスクリプトから、キーの区切り（keys）と検索の区切り
 * （find）を切り出して動かす（manuscriptEditorSave.test.ts と同じやり方）。
 * 区切りの外の関数（ルビを頼む・送る・大きさを当てる…）は、ここで代わりを置く。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

function markedBlock(name: string): string {
  const start = code.indexOf(`/* ${name}:start */`);
  const end = code.indexOf(`/* ${name}:end */`);
  if (start < 0 || end < 0) return "";
  return code.slice(start, end);
}

type Listener = (event: Record<string, unknown>) => void;

interface FakeEvent extends Record<string, unknown> {
  prevented: boolean;
  stopped: boolean;
}

interface Harness {
  key(init: Record<string, unknown>): FakeEvent;
  wheel(init: Record<string, unknown>): FakeEvent;
  /** 検索の欄で押したキー */
  findKey(init: Record<string, unknown>): FakeEvent;
  /** 検索の欄に打つ（input が飛ぶ） */
  findType(text: string): void;
  click(id: string): void;
  posted(): Array<Record<string, unknown>>;
  calls(): string[];
  note(): string;
  size(): number;
  bodyHas(name: string): boolean;
  findCount(): string;
  /** 打つ面に置いた見つけた所の塗り（span の中の字） */
  writeMark(): string;
  /** 組んで書く面に置いた見つけた所の範囲 */
  composeMark(): { start: number; end: number } | null;
  writeSelection(): { start: number; end: number; focused: boolean };
  composeSelection(): { start: number; end: number } | null;
  focused(): string;
  setText(text: string): void;
}

function harness(
  options: {
    composeOn?: boolean;
    selection?: string;
    text?: string;
    caret?: number;
    size?: number;
  } = {}
): Harness {
  const keys = markedBlock("keys");
  const find = markedBlock("find");
  expect(keys, "キーの区切り（keys）が画面に無い").not.toBe("");
  expect(find, "検索の区切り（find）が画面に無い").not.toBe("");
  const env = {
    posted: [] as Array<Record<string, unknown>>,
    calls: [] as string[],
    noteText: "",
    selection: options.selection ?? "",
    text: options.text ?? "",
    caret: options.caret ?? 0,
    composeOn: options.composeOn ?? false,
    size: options.size ?? 16,
    listeners: {} as Record<string, Listener[]>,
    elements: {} as Record<string, Record<string, unknown>>,
    bodyClasses: new Set<string>(),
    focused: "",
    writeSel: { start: 0, end: 0 },
    composeSel: null as null | { start: number; end: number },
    composeMark: null as null | { start: number; end: number },
    writeMarkText: "",
  };
  const on = (key: string, fn: Listener) => {
    (env.listeners[key] ??= []).push(fn);
  };
  const api = new Function(
    "env",
    "on",
    `
    let composing = false;
    let composeOn = env.composeOn;
    let size = env.size;
    let aloudOn = false;
    const vscode = {
      postMessage: (message) => env.posted.push(JSON.parse(JSON.stringify(message))),
    };
    const note = {
      get textContent() { return env.noteText; },
      set textContent(value) { env.noteText = value; },
    };
    function classList(set) {
      return {
        add: (n) => set.add(n),
        remove: (n) => set.delete(n),
        contains: (n) => set.has(n),
        toggle: (n, force) => {
          const want = force === undefined ? !set.has(n) : force;
          if (want) set.add(n); else set.delete(n);
          return want;
        },
      };
    }
    function element(id) {
      if (!env.elements[id]) {
        const el = {
          id,
          tagName: id === "findInput" ? "INPUT" : "DIV",
          value: "",
          textContent: "",
          classList: classList(new Set()),
          addEventListener: (type, fn) => on(id + ":" + type, fn),
          focus: () => { env.focused = id; },
          select: () => {},
          blur: () => { if (env.focused === id) env.focused = ""; },
        };
        env.elements[id] = el;
      }
      return env.elements[id];
    }
    const document = {
      addEventListener: (type, fn) => on("document:" + type, fn),
      getElementById: (id) => element(id),
      createElement: () => ({ className: "", textContent: "" }),
      createTextNode: (text) => ({ text }),
      body: { classList: classList(env.bodyClasses) },
      get activeElement() { return env.focused ? element(env.focused) : null; },
    };
    const write = element("write");
    Object.defineProperty(write, "value", {
      get: () => env.text,
      set: (v) => { env.text = v; },
    });
    Object.defineProperty(write, "selectionStart", { get: () => env.caret });
    Object.defineProperty(write, "selectionEnd", { get: () => env.caret });
    write.setSelectionRange = (start, end) => { env.writeSel = { start, end }; };
    write.tagName = "TEXTAREA";
    const compose = element("compose");
    const aloudMarks = {
      firstChild: null,
      removeChild: () => {},
      appendChild: (child) => {
        if (child && child.className === "mark-find") env.writeMarkText = child.textContent;
      },
    };
    function aloudClearWriteMark() { env.writeMarkText = ""; }
    function alignMarksBox() {}
    function syncMarksScroll() {}
    function aloudNudgeWriteIntoView() { env.calls.push("nudgeWrite"); }
    function aloudFinish() { aloudOn = false; env.calls.push("aloudFinish"); }
    function composeTextNow() { return env.text; }
    function composeSelectionNow() { return { start: env.caret, end: env.caret }; }
    function composeRestoreCaret(at) { env.composeSel = { start: at.start, end: at.end }; }
    function composeNudgeIntoView() { env.calls.push("nudgeCompose"); return true; }
    function composeHighlightsUsable() { return true; }
    const CSS = {
      highlights: {
        set: (name, value) => { if (name === "novelai-find") env.composeMark = value.at; },
        delete: (name) => { if (name === "novelai-find") env.composeMark = null; },
      },
    };
    function composeOffsetToPoint(atoms, offset) { return { node: "n", offset }; }
    function composeCurrentAtoms() { return []; }
    function Highlight(range) { this.at = range.at; }
    document.createRange = () => {
      const r = { at: { start: 0, end: 0 } };
      r.setStart = (node, offset) => { r.at.start = offset; };
      r.setEnd = (node, offset) => { r.at.end = offset; };
      return r;
    };
    function selectionText() { return env.selection; }
    function caretLine() { return 7; }
    function flushUnsent(reason) { env.calls.push("flush:" + reason); }
    function askRuby() { env.calls.push("askRuby"); }
    function askEmphasis() { env.calls.push("askEmphasis"); }
    function viewTakePress() { return "anchor"; }
    function viewRestore() {}
    function paint() { env.calls.push("paint:" + size); }
    function remember() { env.size = size; env.calls.push("remember:" + size); }
    ${keys}
    ${find}
    `
  ) as (env: unknown, on: (key: string, fn: Listener) => void) => void;
  api(env, on);

  function fire(key: string, init: Record<string, unknown>): FakeEvent {
    const event: FakeEvent = {
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
      key: "",
      code: "",
      target: env.elements[env.focused] ?? env.elements["write"],
      prevented: false,
      stopped: false,
      preventDefault() {
        event.prevented = true;
      },
      stopPropagation() {
        event.stopped = true;
      },
      ...init,
    };
    for (const fn of env.listeners[key] ?? []) fn(event);
    return event;
  }

  return {
    key: (init) => fire("document:keydown", init),
    wheel: (init) => fire("document:wheel", init),
    findKey: (init) => fire("findInput:keydown", init),
    findType(text) {
      (env.elements["findInput"] as { value: string }).value = text;
      fire("findInput:input", {});
    },
    click(id) {
      fire(id + ":click", {});
    },
    posted: () => env.posted,
    calls: () => env.calls,
    note: () => env.noteText,
    size: () => env.size,
    bodyHas: (name) => env.bodyClasses.has(name),
    findCount: () => String(env.elements["findCount"]?.textContent ?? ""),
    writeMark: () => env.writeMarkText,
    composeMark: () => env.composeMark,
    writeSelection: () => ({ ...env.writeSel, focused: env.focused === "write" }),
    composeSelection: () => env.composeSel,
    focused: () => env.focused,
    setText(text) {
      env.text = text;
    },
  };
}

describe("Alt+↑／Alt+↓ で前の話・次の話", () => {
  it("打った字を送ってから、隣の話を頼む（キーからは作らない印つき）", () => {
    const h = harness();
    const event = h.key({ key: "ArrowDown", altKey: true });
    expect(h.calls()).toContain("flush:前後の話へ移る");
    expect(h.posted()).toEqual([
      { type: "openNeighbor", direction: "next", line: 7, noCreate: true },
    ]);
    // 本体（VS Code）へ渡さない・カーソルも動かさない
    expect(event.prevented).toBe(true);
    expect(event.stopped).toBe(true);
    h.key({ key: "ArrowUp", altKey: true });
    expect(h.posted()[1]).toMatchObject({ direction: "prev", noCreate: true });
  });

  it("素の矢印・Shift+Alt・Ctrl+Alt・変換中には何もしない（既存の矢印の扱いを壊さない）", () => {
    const h = harness();
    const plain = h.key({ key: "ArrowDown" });
    h.key({ key: "ArrowDown", altKey: true, shiftKey: true });
    h.key({ key: "ArrowDown", altKey: true, ctrlKey: true });
    h.key({ key: "ArrowDown", altKey: true, isComposing: true });
    expect(h.posted()).toEqual([]);
    expect(plain.prevented).toBe(false);
  });
});

describe("Ctrl+Shift+R でルビ、Ctrl+Shift+K で傍点", () => {
  it("選んでいれば、ボタンと同じ道で頼む", () => {
    const h = harness({ selection: "漢字" });
    const ruby = h.key({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true });
    const emph = h.key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    expect(h.calls()).toEqual(["askRuby", "askEmphasis"]);
    expect(ruby.prevented && ruby.stopped).toBe(true);
    expect(emph.prevented && emph.stopped).toBe(true);
  });

  it("選んでいなければ頼まずに一言出す", () => {
    const h = harness({ selection: "" });
    h.key({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true });
    expect(h.calls()).toEqual([]);
    expect(h.note()).toBe("ルビを振る文字を選んでから押してください");
    h.key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    expect(h.note()).toBe("傍点を付ける文字を選んでから押してください");
  });

  it("組んで書く面でも同じ（選択の有無で分ける）", () => {
    const h = harness({ composeOn: true, selection: "語" });
    h.key({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true });
    expect(h.calls()).toEqual(["askRuby"]);
  });

  it("変換中・Shift 無し（Ctrl+R）では何もしない", () => {
    const h = harness({ selection: "漢字" });
    h.key({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true, isComposing: true });
    h.key({ key: "r", code: "KeyR", ctrlKey: true });
    expect(h.calls()).toEqual([]);
  });
});

describe("本文の字の大きさ", () => {
  it("Ctrl+＋／Ctrl+－ で1つずつ変わり、覚える（ボタンと同じ道）", () => {
    const h = harness({ size: 16 });
    const up = h.key({ key: "+", code: "Semicolon", ctrlKey: true, shiftKey: true });
    expect(h.size()).toBe(17);
    expect(up.prevented && up.stopped).toBe(true);
    h.key({ key: "=", code: "Equal", ctrlKey: true });
    h.key({ key: ";", code: "Semicolon", ctrlKey: true });
    expect(h.size()).toBe(19);
    h.key({ key: "-", code: "Minus", ctrlKey: true });
    expect(h.size()).toBe(18);
    h.key({ key: "-", code: "NumpadSubtract", ctrlKey: true });
    expect(h.size()).toBe(17);
  });

  it("Ctrl+0 で既定（16px）へ戻す", () => {
    const h = harness({ size: 22 });
    h.key({ key: "0", code: "Digit0", ctrlKey: true });
    expect(h.size()).toBe(16);
  });

  it("上限40・下限9で止まる", () => {
    const h = harness({ size: 40 });
    h.key({ key: "+", ctrlKey: true, shiftKey: true });
    expect(h.size()).toBe(40);
    const low = harness({ size: 9 });
    low.key({ key: "-", ctrlKey: true });
    expect(low.size()).toBe(9);
  });

  it("Ctrl+ホイールは1目盛りで1つ。VS Code 全体のズームへは渡さない", () => {
    const h = harness({ size: 16 });
    const event = h.wheel({ ctrlKey: true, deltaY: -100, deltaMode: 0 });
    expect(h.size()).toBe(17);
    expect(event.prevented && event.stopped).toBe(true);
    h.wheel({ ctrlKey: true, deltaY: 100, deltaMode: 0 });
    h.wheel({ ctrlKey: true, deltaY: 100, deltaMode: 0 });
    expect(h.size()).toBe(15);
    // トラックパッドの細かい動きは溜めてから1つ
    h.wheel({ ctrlKey: true, deltaY: -40, deltaMode: 0 });
    expect(h.size()).toBe(15);
    h.wheel({ ctrlKey: true, deltaY: -60, deltaMode: 0 });
    expect(h.size()).toBe(16);
  });

  it("Ctrl の無いホイールには触らない（縦書きの送りを壊さない）", () => {
    const h = harness({ size: 16 });
    const event = h.wheel({ deltaY: 100, deltaMode: 0 });
    expect(h.size()).toBe(16);
    expect(event.prevented).toBe(false);
  });

  it("変換中の Ctrl+－ は日本語入力に任せる", () => {
    const h = harness({ size: 16 });
    h.key({ key: "-", ctrlKey: true, isComposing: true });
    expect(h.size()).toBe(16);
  });
});

describe("Ctrl+F で本文を探す（打つ面）", () => {
  const text = "猫が鳴いた。犬も鳴いた。猫は寝た。";

  it("Ctrl+F で検索の列を開き、欄へ焦点を移す（VS Code 本体へは渡さない）", () => {
    const h = harness({ text });
    const event = h.key({ key: "f", code: "KeyF", ctrlKey: true });
    expect(h.bodyHas("finding")).toBe(true);
    expect(h.focused()).toBe("findInput");
    expect(event.prevented && event.stopped).toBe(true);
  });

  it("打つと、カーソルより後ろの最初の所を塗って件数を出す。Enter で次、Shift+Enter で前（端で回る）", () => {
    const h = harness({ text, caret: 3 });
    h.key({ key: "f", ctrlKey: true });
    h.findType("鳴いた");
    // カーソル（3字目）より前の「鳴いた」（2字目）は飛ばす
    expect(h.findCount()).toBe("2／2");
    expect(h.writeMark()).toBe("鳴いた");
    h.findKey({ key: "Enter" });
    expect(h.findCount()).toBe("1／2");
    h.findKey({ key: "Enter" });
    expect(h.findCount()).toBe("2／2");
    h.findKey({ key: "Enter", shiftKey: true });
    expect(h.findCount()).toBe("1／2");
    // 探している間は、原稿の選択にも焦点にも触らない
    expect(h.focused()).toBe("findInput");
  });

  it("変換中の Enter では探さない（確定のための Enter）", () => {
    const h = harness({ text });
    h.key({ key: "f", ctrlKey: true });
    h.findType("猫");
    expect(h.findCount()).toBe("1／2");
    const event = h.findKey({ key: "Enter", isComposing: true });
    expect(h.findCount()).toBe("1／2");
    expect(event.prevented).toBe(false);
  });

  it("見つからなければそう言う", () => {
    const h = harness({ text });
    h.key({ key: "f", ctrlKey: true });
    h.findType("鳥");
    expect(h.findCount()).toBe("見つかりません");
    expect(h.writeMark()).toBe("");
  });

  it("Esc で閉じ、見つけた所を選んで原稿へ戻る", () => {
    const h = harness({ text });
    h.key({ key: "f", ctrlKey: true });
    h.findType("犬");
    h.findKey({ key: "Escape" });
    expect(h.bodyHas("finding")).toBe(false);
    expect(h.writeSelection()).toEqual({ start: 6, end: 7, focused: true });
    expect(h.writeMark()).toBe("");
  });

  it("選んだ語があれば、それを欄に入れて開く", () => {
    const h = harness({ text, selection: "犬" });
    h.key({ key: "f", ctrlKey: true });
    expect(h.findCount()).toBe("1／1");
  });
});

describe("Ctrl+F で本文を探す（組んで書く面）", () => {
  it("記法の位置で探し、色を置き、閉じたら選択を置く", () => {
    const h = harness({ composeOn: true, text: "｜漢字《かんじ》と漢字" });
    h.key({ key: "f", ctrlKey: true });
    h.findType("漢字");
    expect(h.findCount()).toBe("1／2");
    expect(h.composeMark()).toEqual({ start: 1, end: 3 });
    expect(h.calls()).toContain("nudgeCompose");
    h.findKey({ key: "Enter" });
    expect(h.composeMark()).toEqual({ start: 9, end: 11 });
    h.click("findClose");
    expect(h.composeMark()).toBeNull();
    expect(h.composeSelection()).toEqual({ start: 9, end: 11 });
  });
});

describe("既存のキーを壊さない", () => {
  it("Ctrl+S・Esc はこの区切りでは扱わない", () => {
    const h = harness({ selection: "語" });
    const save = h.key({ key: "s", ctrlKey: true });
    const esc = h.key({ key: "Escape" });
    expect(save.prevented || save.stopped).toBe(false);
    expect(esc.prevented || esc.stopped).toBe(false);
    expect(h.posted()).toEqual([]);
  });

  it("F1・F5・F6〜F10・Ctrl+P・Ctrl+Shift+P は使わない", () => {
    const h = harness({ selection: "語" });
    for (const key of ["F1", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]) {
      expect(h.key({ key }).prevented).toBe(false);
    }
    expect(h.key({ key: "p", ctrlKey: true }).prevented).toBe(false);
    expect(h.key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }).prevented).toBe(false);
  });

  it("本体の Ctrl+S（保存を頼む）はそのまま画面にある", () => {
    expect(code).toMatch(/function askSave\(\)/);
    expect(code).toMatch(/flushUnsent\("保存する"\)/);
  });
});
