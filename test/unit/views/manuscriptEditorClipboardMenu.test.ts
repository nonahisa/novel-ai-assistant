import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 原稿エディターの右クリックの「切り取り」「コピー」「貼り付け」
 * （作者の裁定、2026-09-28「足す」。設計書6.25）。
 *
 * 画面へ渡る本物のスクリプトを切り出し、面（textarea／組んで書く面）と
 * execCommand を作り物にして動かす（manuscriptEditorUnsent.test.ts と同じやり方）。
 * **本文が文書へ届くのは、打鍵と同じ送り（postEdit の edit 便）だけ**であることを確かめる。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

function markedBlock(name: string): string {
  const start = code.indexOf(`/* ${name}:start */`);
  const end = code.indexOf(`/* ${name}:end */`);
  expect(start, `${name} の印が画面に無い`).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

function functionSource(name: string, until: string): string {
  const start = code.indexOf(`function ${name}(`);
  const end = code.indexOf(until, start);
  expect(start, `${name} が見つからない`).toBeGreaterThan(0);
  expect(end, `${name} の終わりが見つからない`).toBeGreaterThan(start);
  return code.slice(start, end);
}

/* ── 品書きの並び ─────────────────────────────── */

interface MenuItem {
  kind: "item" | "rule";
  label: string;
  disabled: boolean;
  click?: () => void;
}

function runOpenMenu(options: { term: boolean; hasSelection: boolean }): {
  items: MenuItem[];
  called: string[];
} {
  const source = functionSource("openMenu", "function termAtCaret(");
  const env = { items: [] as MenuItem[], called: [] as string[] };
  const openMenu = new Function(
    "env",
    `
    const composeOn = false;
    const composeMenuAt = null;
    const write = { selectionStart: 0, selectionEnd: 0 };
    const vscode = { postMessage() {} };
    const window = { innerWidth: 1000, innerHeight: 1000 };
    let menuTerm = null;
    function closeMenu() {}
    function menuCut() { env.called.push("cut"); }
    function menuCopy() { env.called.push("copy"); }
    function menuPaste() { env.called.push("paste"); }
    function askRuby() {}
    function askEmphasis() {}
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
  )(env) as (x: number, y: number, term: unknown, hasSelection: boolean) => void;
  openMenu(
    0,
    0,
    options.term ? { id: "c1", kind: "character", name: "名" } : null,
    options.hasSelection
  );
  return env;
}

describe("右クリックの品書きの並び", () => {
  it("**用語の上では設定資料が先頭、その次に「切り取り」「コピー」「貼り付け」と区切り線**（作者の依頼、2026-09-28）", () => {
    const { items } = runOpenMenu({ term: true, hasSelection: true });
    expect(items.slice(0, 6).map((item) => (item.kind === "rule" ? "―" : item.label))).toEqual([
      "設定資料を見る",
      "―",
      "切り取り",
      "コピー",
      "貼り付け",
      "―",
    ]);
    // これまでの項目は残っている
    const labels = items.map((item) => item.label);
    expect(labels).toContain("ルビ付与");
    expect(labels).toContain("コピー（記法のまま）");
  });

  it("名前は短く、名詞止めにそろえる（作者の案、2026-10-03）", () => {
    const { items } = runOpenMenu({ term: false, hasSelection: true });
    const labels = items.filter((item) => item.kind === "item").map((item) => item.label);
    expect(labels).toEqual([
      "切り取り",
      "コピー",
      "貼り付け",
      // ルビ・傍点はコマンドの題に揃える（作者の裁定、2026-10-03）
      "ルビ付与",
      "傍点付与",
      "コピー（投稿サイト用）",
      "コピー（記法のまま）",
      "AI相談（選択範囲）",
      "メモ追加",
      "校正・メモパネルを開く",
      "単話プロットを開く",
      // 詳細メニューの名前をそのまま使う（actionTree の novelai.resumeWriting）
      "執筆再開用資料生成",
    ]);
  });

  it("用語の上でなくても、先頭は同じ3つ", () => {
    const { items } = runOpenMenu({ term: false, hasSelection: false });
    expect(items.slice(0, 3).map((item) => item.label)).toEqual(["切り取り", "コピー", "貼り付け"]);
    expect(items[3].kind).toBe("rule");
  });

  it("**選んでいないと、切り取り・コピーは押せない**（貼り付けは押せる）", () => {
    const { items, called } = runOpenMenu({ term: false, hasSelection: false });
    const [cut, copy, paste] = items;
    expect(cut.disabled).toBe(true);
    expect(copy.disabled).toBe(true);
    expect(paste.disabled).toBe(false);
    cut.click?.();
    copy.click?.();
    paste.click?.();
    expect(called).toEqual(["paste"]);
  });

  it("選んでいれば3つとも押せて、それぞれの処理へ届く", () => {
    const { items, called } = runOpenMenu({ term: false, hasSelection: true });
    for (const item of items.slice(0, 3)) item.click?.();
    expect(called).toEqual(["cut", "copy", "paste"]);
  });
});

/* ── 切り取り・コピー・貼り付けの動き ───────────────── */

interface Harness {
  menuCut(): void;
  menuCopy(): void;
  menuPaste(): void;
  takeClipboardText(message: unknown): void;
  takeClipboardWritten(message: unknown): void;
  /** 時計を進め、期限の来た予約を走らせる */
  advance(ms: number): void;
  /** 画面から拡張機能へ送った用件 */
  posted: Array<{ type: string; text?: string; id?: number }>;
  /** 呼ばれた execCommand の順 */
  commands: string[];
  /** execCommand("copy") で写ったもの */
  clipboard: string[];
  text(): string;
  note(): string;
  setText(text: string): void;
}

function harness(options: {
  composeOn: boolean;
  text: string;
  start: number;
  end: number;
  refuse?: string[];
}): Harness {
  const block = markedBlock("menu-clipboard");
  const env = {
    composeOn: options.composeOn,
    text: options.text,
    sel: { start: options.start, end: options.end },
    posted: [] as Array<{ type: string; text?: string; id?: number }>,
    commands: [] as string[],
    now: 0,
    timers: [] as Array<{ at: number; fn: () => void; id: number }>,
    nextTimer: 1,
    clipboard: [] as string[],
    note: "",
    refuse: options.refuse ?? [],
  };
  const api = new Function(
    "env",
    `
    const composeOn = env.composeOn;
    function setTimeout(fn, ms) {
      const id = env.nextTimer++;
      env.timers.push({ at: env.now + (ms || 0), fn, id });
      return id;
    }
    function clearTimeout(id) { env.timers = env.timers.filter((t) => t.id !== id); }
    // 組んで書く面では、選択は品書きを開いた時点に控えてある
    const composeMenuAt = env.composeOn ? { start: env.sel.start, end: env.sel.end } : null;
    const composeNotation = "curly";
    const composeCopyEmphasis = "kakuyomu";
    const vscode = { postMessage: (message) => env.posted.push(message) };
    const note = {
      get textContent() { return env.note; },
      set textContent(value) { env.note = value; },
    };
    let current = env.text;
    // 本物と同じ：送るのは input の知らせから（打鍵と同じ道）
    function postEdit(text) { env.posted.push({ type: "edit", text: text }); }
    function send() { if (env.text === current) return; current = env.text; postEdit(current); }
    function composeSend() { send(); }
    function fireInput() { if (composeOn) composeSend(); else send(); }
    const write = {
      get value() { return env.text; },
      get selectionStart() { return env.sel.start; },
      get selectionEnd() { return env.sel.end; },
      focus() {},
      setSelectionRange(start, end) { env.sel = { start, end }; },
      setRangeText(text, start, end) {
        env.text = env.text.slice(0, start) + text + env.text.slice(end);
        env.sel = { start: start + text.length, end: start + text.length };
      },
    };
    const compose = { focus() {} };
    function composeTextNow() { return env.text; }
    function composeRestoreCaret(at) { if (at) env.sel = { start: at.start, end: at.end }; }
    function composeSelectionNow() { return { start: env.sel.start, end: env.sel.end }; }
    function composeCopyPayloads(text) { return { plain: "字:" + text, html: text, notation: text }; }
    function composeTryDelete() { return document.execCommand("delete") === true; }
    function composeInsertPlain(text) { document.execCommand("insertText", false, text); }
    const document = {
      execCommand(command, ui, value) {
        env.commands.push(command);
        if (env.refuse.indexOf(command) >= 0) return false;
        const s = env.sel;
        if (command === "copy") {
          env.clipboard.push(env.text.slice(s.start, s.end));
          return true;
        }
        if (command === "delete") {
          if (s.end <= s.start) return false;
          env.text = env.text.slice(0, s.start) + env.text.slice(s.end);
          env.sel = { start: s.start, end: s.start };
          fireInput();
          return true;
        }
        if (command === "insertText") {
          env.text = env.text.slice(0, s.start) + value + env.text.slice(s.end);
          env.sel = { start: s.start + value.length, end: s.start + value.length };
          fireInput();
          return true;
        }
        return false;
      },
    };
    ${block}
    return { menuCut, menuCopy, menuPaste, takeClipboardText, takeClipboardWritten };
    `
  )(env) as Pick<
    Harness,
    "menuCut" | "menuCopy" | "menuPaste" | "takeClipboardText" | "takeClipboardWritten"
  >;
  return {
    ...api,
    advance(ms) {
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
    posted: env.posted,
    commands: env.commands,
    clipboard: env.clipboard,
    text: () => env.text,
    note: () => env.note,
    setText: (text) => {
      env.text = text;
    },
  };
}

function edits(h: Harness): string[] {
  return h.posted.filter((message) => message.type === "edit").map((message) => message.text ?? "");
}

for (const composeOn of [false, true]) {
  const face = composeOn ? "組んで書く面" : "打つ面（縦書き・横書き）";

  describe(`${face}の切り取り`, () => {
    it("**写してから消し、消えた本文が打鍵と同じ便で文書へ送られる**", () => {
      const h = harness({ composeOn, text: "あいうえお", start: 1, end: 3 });
      h.menuCut();
      expect(h.clipboard).toEqual(["いう"]);
      expect(h.text()).toBe("あえお");
      expect(edits(h)).toEqual(["あえお"]);
      // 写す→消すの順。execCommand("cut") は使わない（入れ子で delete が断られる）
      expect(h.commands).toEqual(["copy", "delete"]);
    });

    it("delete を断られても字は失わない（写したまま、消せなかったことを知らせるか直接消して送る）", () => {
      const h = harness({ composeOn, text: "あいうえお", start: 1, end: 3, refuse: ["delete"] });
      h.menuCut();
      expect(h.clipboard).toEqual(["いう"]);
      if (composeOn) {
        expect(h.text()).toBe("あいうえお");
        expect(h.note()).toContain("Delete");
      } else {
        expect(edits(h)).toEqual(["あえお"]);
      }
    });

    /*
      画面の copy が断られたときは拡張機能に写してもらう。**写し終わった返事
      （成功）が来るまで消さない**——写せなかったのに消すと、字がどこにも
      残らない（実装ルール1）。
    */
    function cutRefused() {
      const h = harness({ composeOn, text: "あいうえお", start: 0, end: 2, refuse: ["copy"] });
      h.menuCut();
      const write = h.posted.find((message) => message.type === "clipboardWrite");
      expect(write?.text).toBe(composeOn ? "字:あい" : "あい");
      expect(typeof write?.id, "返事と突き合わせる番号が無い").toBe("number");
      return { h, id: write!.id! };
    }

    it("**copy を断られたら、拡張機能が写し終わったと返すまで消さない**", () => {
      const { h, id } = cutRefused();
      expect(h.text(), "写し終わる前に消している").toBe("あいうえお");
      expect(edits(h)).toEqual([]);
      h.takeClipboardWritten({ type: "clipboardWritten", id, ok: true });
      expect(h.text()).toBe("うえお");
      expect(edits(h)).toEqual(["うえお"]);
    });

    it("**拡張機能が写せなかったと返したら、消さずに知らせる**", () => {
      const { h, id } = cutRefused();
      h.takeClipboardWritten({ type: "clipboardWritten", id, ok: false });
      expect(h.text()).toBe("あいうえお");
      expect(edits(h)).toEqual([]);
      expect(h.note()).toContain("切り取れませんでした（字は消していません）");
    });

    it("**返事が来ないまま待ちが過ぎたら、消さずに知らせる（遅れて届いた返事でも消さない）**", () => {
      const { h, id } = cutRefused();
      h.advance(10_000);
      expect(h.text()).toBe("あいうえお");
      expect(h.note()).toContain("切り取れませんでした（字は消していません）");
      h.takeClipboardWritten({ type: "clipboardWritten", id, ok: true });
      expect(h.text()).toBe("あいうえお");
      expect(edits(h)).toEqual([]);
    });

    it("待つ間に本文が変わっていたら、消さずに知らせる（控えた位置が当てにならない）", () => {
      const { h, id } = cutRefused();
      h.setText("xあいうえお");
      h.takeClipboardWritten({ type: "clipboardWritten", id, ok: true });
      expect(h.text()).toBe("xあいうえお");
      expect(edits(h)).toEqual([]);
      expect(h.note()).toContain("字は消していません");
    });

    it("別の便の返事では消さない", () => {
      const { h, id } = cutRefused();
      h.takeClipboardWritten({ type: "clipboardWritten", id: id + 100, ok: true });
      expect(h.text()).toBe("あいうえお");
    });
  });

  describe(`${face}のコピー`, () => {
    it("写すだけで、本文は変えない", () => {
      const h = harness({ composeOn, text: "あいうえお", start: 1, end: 4 });
      h.menuCopy();
      expect(h.clipboard).toEqual(["いうえ"]);
      expect(h.text()).toBe("あいうえお");
      expect(edits(h)).toEqual([]);
    });

    it("選んでいなければ何もしない", () => {
      const h = harness({ composeOn, text: "あいうえお", start: 2, end: 2 });
      h.menuCopy();
      h.menuCut();
      expect(h.commands).toEqual([]);
      expect(h.posted).toEqual([]);
    });
  });

  describe(`${face}の貼り付け`, () => {
    it("**拡張機能にクリップボードを頼み、返ってきた字を控えた位置へ入れて送る**", () => {
      const h = harness({ composeOn, text: "あいう", start: 1, end: 2 });
      h.menuPaste();
      expect(h.posted).toEqual([{ type: "clipboardRead" }]);
      h.takeClipboardText({ type: "clipboardText", text: "貼る字" });
      expect(h.text()).toBe("あ貼る字う");
      expect(edits(h)).toEqual(["あ貼る字う"]);
      expect(h.commands).toEqual(["insertText"]);
    });

    it("クリップボードが空なら、本文を変えずに知らせる", () => {
      const h = harness({ composeOn, text: "あいう", start: 1, end: 1 });
      h.menuPaste();
      h.takeClipboardText({ type: "clipboardText", text: "" });
      expect(h.text()).toBe("あいう");
      expect(edits(h)).toEqual([]);
      expect(h.note()).toContain("クリップボード");
    });

    it("頼んでいない返事は捨てる（2度目の返事で二重に入らない）", () => {
      const h = harness({ composeOn, text: "あいう", start: 3, end: 3 });
      h.menuPaste();
      h.takeClipboardText({ type: "clipboardText", text: "え" });
      h.takeClipboardText({ type: "clipboardText", text: "え" });
      expect(h.text()).toBe("あいうえ");
    });
  });
}

describe("打つ面の貼り付けの改行", () => {
  it("CRLF は LF にして入れる（打つ面の本文はLF空間）", () => {
    const h = harness({ composeOn: false, text: "", start: 0, end: 0 });
    h.menuPaste();
    h.takeClipboardText({ type: "clipboardText", text: "一行目\r\n二行目" });
    expect(h.text()).toBe("一行目\n二行目");
  });
});

describe("拡張機能からの返事の受け口", () => {
  it("clipboardText を受けて takeClipboardText へ渡す", () => {
    const start = code.indexOf('window.addEventListener("message"');
    const handler = code.slice(start, code.indexOf("\n  });", start));
    expect(handler).toMatch(/message\.type === "clipboardText"[\s\S]{0,200}takeClipboardText\(message\)/);
    expect(handler).toMatch(
      /message\.type === "clipboardWritten"[\s\S]{0,200}takeClipboardWritten\(message\)/
    );
  });
});
