import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 原稿エディターで打った字が、文書（`TextDocument`）へ届かないまま消えた
 * （作者の報告、2026-09-28。ノートPC・0.89.0）。
 *
 * 「×ボタンで消したら400文字ぐらいが消えました。自動保存がきいていません」
 * 「コントロールSしても文字が変わらなかった」
 *
 * 画面の字は WebView の中だけにあり、文書は空のままだった（VS Code の
 * 退避も空＝文書から見て未変更）。ここでは、**画面の字が文書へ届かない条件**と、
 * **届かないまま閉じても消えない仕組み**を、画面へ渡る本物のスクリプトを
 * 切り出して確かめる（composeFace.test.ts と同じやり方）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

/** `owner.addEventListener("type", function (...) {...});` をまるごと切り出す */
function listenerSource(owner: string, type: string): string {
  const head = `  ${owner}.addEventListener("${type}", function (`;
  const start = code.indexOf(head);
  expect(start, `${owner} の ${type} の受け口が見つからない`).toBeGreaterThan(0);
  const close = "\n  });";
  const end = code.indexOf(close, start);
  return code.slice(start, end + close.length);
}

/** 印（`/* name:start *\/` 〜 `/* name:end *\/`）の間。無ければ空文字 */
function markedBlock(name: string): string {
  const start = code.indexOf(`/* ${name}:start */`);
  const end = code.indexOf(`/* ${name}:end */`);
  if (start < 0 || end < 0) return "";
  return code.slice(start, end);
}

/** 関数の宣言から、次に来る目印の手前までを切り出す */
function functionSource(name: string, until: string): string {
  const start = code.indexOf(`function ${name}(`);
  const end = code.indexOf(until, start);
  expect(start, `${name} が見つからない`).toBeGreaterThan(0);
  expect(end, `${name} の終わりが見つからない`).toBeGreaterThan(start);
  return code.slice(start, end);
}

/* ── 変換中の印が立ったまま戻らない ─────────────────────────── */

describe("変換中の印（composing）が立ったまま戻らなくても、打った字は送る", () => {
  /**
   * 打つ面・組んで書く面の input の受け口を、印が立ったままの状態で動かす。
   *
   * 印は compositionstart で立ち、compositionend で下りる。**終わりの合図が
   * 来ないと、以後の打鍵はすべて「変換中」として捨てられる**（送らない）。
   * 窓の切り替え・スリープ・焦点の移動で合図が落ちることがある。
   */
  function runInput(
    owner: "compose" | "write",
    event: { isComposing?: boolean }
  ): { sent: number; composing: boolean; posted: Array<{ type: string; text?: string }> } {
    const listener = listenerSource(owner, "input");
    const heal = markedBlock("composing-heal");
    const env = {
      sent: 0,
      posted: [] as Array<{ type: string; text?: string }>,
    };
    const run = new Function(
      "env",
      `
      let composing = true;
      let pending = "変換中に届いた古い本文";
      let composePending = "変換中に届いた古い本文";
      const vscode = { postMessage: (message) => env.posted.push(message) };
      const handlers = {};
      const compose = { addEventListener: (type, fn) => { handlers["compose:" + type] = fn; } };
      const write = { addEventListener: (type, fn) => { handlers["write:" + type] = fn; } };
      const marks = { classList: { add() {} } };
      function composeInvalidate() {}
      function composeUnwrapStaleMarks() {}
      function composeSend() { env.sent += 1; }
      function send() { env.sent += 1; }
      function composeScheduleHighlight() {}
      function composeRepaintMemos() {}
      ${heal}
      ${listener}
      return {
        fire: (event) => handlers["${owner}:input"](event),
        composing: () => composing,
      };
      `
    )(env) as { fire: (event: unknown) => void; composing: () => boolean };
    run.fire(event);
    return { sent: env.sent, composing: run.composing(), posted: env.posted };
  }

  for (const owner of ["compose", "write"] as const) {
    it(`${owner}：打鍵の知らせが「変換中ではない」と言うなら、印を下ろして送る`, () => {
      const result = runInput(owner, { isComposing: false });
      expect(result.sent, "打った字が文書へ送られていない").toBe(1);
      expect(result.composing).toBe(false);
      // 取りこぼしは記録に残す（実機で起きたかを後から確かめる手がかり）
      expect(
        result.posted.some(
          (message) => message.type === "log" && /compositionend/.test(message.text ?? "")
        )
      ).toBe(true);
    });

    it(`${owner}：本当に変換中の打鍵は、これまでどおり送らない（IMEを壊さない）`, () => {
      const result = runInput(owner, { isComposing: true });
      expect(result.sent).toBe(0);
      expect(result.composing).toBe(true);
    });

    it(`${owner}：変換中かを言わない知らせ（古い環境）は、これまでどおり待たせる`, () => {
      const result = runInput(owner, {});
      expect(result.sent).toBe(0);
    });
  }
});

/* ── 届いたかを確かめる・届かないまま閉じない ──────────────────── */

interface FakeClassList {
  names: Set<string>;
  add(name: string): void;
  remove(name: string): void;
  contains(name: string): boolean;
}

function fakeClassList(): FakeClassList {
  const names = new Set<string>();
  return {
    names,
    add: (name) => names.add(name),
    remove: (name) => names.delete(name),
    contains: (name) => names.has(name),
  };
}

interface UnsentHarness {
  postEdit(text: string): void;
  receive(message: unknown): void;
  /** 時計を進め、期限の来た予約を順に走らせる */
  advance(ms: number): void;
  fireWindow(type: string, event?: unknown): void;
  fireDocument(type: string, event?: unknown): void;
  setComposing(value: boolean): void;
  composing(): boolean;
  bannerOpen(): boolean;
  edits(): Array<{ text: string; seq: number }>;
  logs(): string[];
  note(): string;
  forcedSends(): number;
  setVisibility(state: string): void;
}

function unsentHarness(options: { composeOn?: boolean; text?: string } = {}): UnsentHarness {
  const block = markedBlock("unsent");
  expect(block, "届いたかを確かめる仕組み（unsent）が画面に無い").not.toBe("");
  const env = {
    now: 0,
    timers: [] as Array<{ at: number; fn: () => void; id: number }>,
    nextId: 1,
    posted: [] as Array<{ type: string; text?: string; seq?: number }>,
    windowHandlers: {} as Record<string, Array<(event: unknown) => void>>,
    documentHandlers: {} as Record<string, Array<(event: unknown) => void>>,
    bar: fakeClassList(),
    noteText: "",
    forced: 0,
    text: options.text ?? "打った字",
    composeOn: options.composeOn ?? true,
    visibility: "visible",
  };
  const api = new Function(
    "env",
    `
    let composing = false;
    let pending = null;
    let composePending = null;
    let composeOn = env.composeOn;
    const vscode = { postMessage: (message) => env.posted.push(message) };
    const note = {
      get textContent() { return env.noteText; },
      set textContent(value) { env.noteText = value; },
    };
    const unsentBar = { classList: env.bar };
    const unsentText = { textContent: "" };
    const unsentCopyButton = { addEventListener() {} };
    const Date = { now: () => env.now };
    function setTimeout(fn, ms) {
      const id = env.nextId++;
      env.timers.push({ at: env.now + (ms || 0), fn, id });
      return id;
    }
    function clearTimeout(id) {
      env.timers = env.timers.filter((timer) => timer.id !== id);
    }
    const window = {
      addEventListener: (type, fn) => {
        (env.windowHandlers[type] = env.windowHandlers[type] || []).push(fn);
      },
    };
    const document = {
      get visibilityState() { return env.visibility; },
      addEventListener: (type, fn) => {
        (env.documentHandlers[type] = env.documentHandlers[type] || []).push(fn);
      },
    };
    let current = "";
    // 本物の send / composeSend と同じ約束：同じ本文なら送らない、force なら送る
    function composeSend(force) {
      if (force) env.forced += 1;
      if (!force && env.text === current) return;
      current = env.text;
      postEdit(env.text);
    }
    function send(force) { composeSend(force); }
    function composeDomToNotation() { return env.text; }
    const compose = {};
    const write = { get value() { return env.text; } };
    ${block}
    return {
      postEdit: (text) => { current = text; postEdit(text); },
      receive: (message) => takeEditApplied(message),
      setComposing: (value) => { composing = value; },
      composing: () => composing,
    };
    `
  )(env) as {
    postEdit(text: string): void;
    receive(message: unknown): void;
    setComposing(value: boolean): void;
    composing(): boolean;
  };

  return {
    postEdit: (text) => api.postEdit(text),
    receive: (message) => api.receive(message),
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
    fireWindow(type, event) {
      for (const fn of env.windowHandlers[type] ?? []) fn(event ?? {});
    },
    fireDocument(type, event) {
      for (const fn of env.documentHandlers[type] ?? []) fn(event ?? {});
    },
    setComposing: (value) => api.setComposing(value),
    composing: () => api.composing(),
    bannerOpen: () => env.bar.contains("open"),
    edits: () =>
      env.posted
        .filter((message) => message.type === "edit")
        .map((message) => ({ text: message.text ?? "", seq: message.seq ?? -1 })),
    logs: () =>
      env.posted.filter((message) => message.type === "log").map((message) => message.text ?? ""),
    note: () => env.noteText,
    forcedSends: () => env.forced,
    setVisibility(state) {
      env.visibility = state;
    },
  };
}

describe("打った字が文書へ届いたかを確かめる（設計書6.25.9）", () => {
  it("送る便には番号を付ける", () => {
    const h = unsentHarness();
    h.postEdit("あ");
    h.postEdit("あい");
    expect(h.edits()).toEqual([
      { text: "あ", seq: 1 },
      { text: "あい", seq: 2 },
    ]);
  });

  it("届いた知らせが来れば、何も出さない", () => {
    const h = unsentHarness();
    h.postEdit("あ");
    h.receive({ type: "editApplied", seq: 1, ok: true });
    h.advance(20_000);
    expect(h.bannerOpen()).toBe(false);
    expect(h.forcedSends()).toBe(0);
  });

  it("**届いた知らせが来ないまま待ちが過ぎたら、画面に知らせを出して送り直す**", () => {
    const h = unsentHarness();
    h.postEdit("打った字");
    h.advance(3_000);
    expect(h.bannerOpen(), "まだ待ちの内").toBe(false);
    h.advance(2_000);
    expect(h.bannerOpen(), "届いていないのに黙っている").toBe(true);
    expect(h.forcedSends()).toBe(1);
    // 送り直した便に届いた知らせが来たら、知らせを下ろして一言添える
    const last = h.edits().at(-1)!;
    h.receive({ type: "editApplied", seq: last.seq, ok: true });
    expect(h.bannerOpen()).toBe(false);
    expect(h.note()).toContain("原稿に入りました");
  });

  it("届くまで、間を置いて送り直し続ける", () => {
    const h = unsentHarness();
    h.postEdit("打った字");
    h.advance(30_000);
    expect(h.forcedSends()).toBeGreaterThanOrEqual(5);
    expect(h.bannerOpen()).toBe(true);
  });

  it("**打ち続けていても、最初の便から数えて知らせる**（打つたびに待ちを延ばさない）", () => {
    const h = unsentHarness();
    h.postEdit("あ");
    h.advance(2_000);
    h.postEdit("あい");
    h.advance(2_000);
    h.postEdit("あいう");
    h.advance(1_000);
    expect(h.bannerOpen()).toBe(true);
  });

  it("入れられなかったと返ってきたら、待たずに知らせる", () => {
    const h = unsentHarness();
    h.postEdit("あ");
    h.receive({ type: "editApplied", seq: 1, ok: false });
    expect(h.bannerOpen()).toBe(true);
  });

  it("古い便の知らせだけが届いたときは、流れているので待ち直す", () => {
    const h = unsentHarness();
    h.postEdit("あ");
    h.advance(3_000);
    h.postEdit("あい");
    h.receive({ type: "editApplied", seq: 1, ok: true });
    h.advance(3_000);
    expect(h.bannerOpen()).toBe(false);
    h.receive({ type: "editApplied", seq: 2, ok: true });
    h.advance(20_000);
    expect(h.bannerOpen()).toBe(false);
  });

  it("本当に変換中なら、送り直さずに次の見回りを待つ", () => {
    const h = unsentHarness();
    h.postEdit("あ");
    h.setComposing(true);
    h.advance(5_000);
    expect(h.bannerOpen()).toBe(true);
    expect(h.forcedSends()).toBe(0);
  });
});

describe("画面を離れる前に、未送信の字を送る", () => {
  it("**焦点が画面の外へ出たら（タブの×・別の窓）、変換中の印が立ったままでも送る**", () => {
    const h = unsentHarness({ text: "閉じる前に打った字" });
    h.setComposing(true);
    h.fireWindow("blur");
    expect(h.composing()).toBe(false);
    expect(h.edits().map((edit) => edit.text)).toEqual(["閉じる前に打った字"]);
    expect(h.logs().some((text) => /変換中の印/.test(text))).toBe(true);
  });

  it("画面が隠れるとき・閉じるときも送る", () => {
    const hidden = unsentHarness({ text: "隠れる前" });
    hidden.setVisibility("hidden");
    hidden.fireDocument("visibilitychange");
    expect(hidden.edits().map((edit) => edit.text)).toEqual(["隠れる前"]);

    const shown = unsentHarness({ text: "見えている" });
    shown.fireDocument("visibilitychange");
    expect(shown.edits()).toEqual([]);

    const closing = unsentHarness({ text: "閉じる前" });
    closing.fireWindow("pagehide");
    expect(closing.edits().map((edit) => edit.text)).toEqual(["閉じる前"]);
  });

  it("**Ctrl+S の前に送る**（保存に最後の字が間に合うように）", () => {
    const h = unsentHarness({ text: "保存する字" });
    h.fireDocument("keydown", { key: "s", ctrlKey: true, isComposing: false });
    expect(h.edits().map((edit) => edit.text)).toEqual(["保存する字"]);
  });

  it("変換中の Ctrl+S では送らない（日本語入力に任せる）", () => {
    const h = unsentHarness({ text: "保存する字" });
    h.setComposing(true);
    h.fireDocument("keydown", { key: "s", ctrlKey: true, isComposing: true });
    expect(h.edits()).toEqual([]);
    expect(h.composing()).toBe(true);
  });

  it("同じ本文なら、離れるたびに送り直さない", () => {
    const h = unsentHarness({ text: "同じ" });
    h.fireWindow("blur");
    h.fireWindow("blur");
    expect(h.edits()).toHaveLength(1);
  });
});

describe("届かないときの知らせの帯", () => {
  it("帯と「本文をコピー」のボタンが画面にある", () => {
    expect(html).toContain('id="unsent"');
    expect(html).toContain('id="unsentCopy"');
    // 開発中の呼び名や英語を出さない。作者が次に取る操作を書く
    const bar = html.slice(html.indexOf('id="unsent"'), html.indexOf('id="unsentCopy"') + 200);
    expect(bar).toContain("本文をコピー");
  });
});

/* ── Ctrl+X（切り取り）──────────────────────────────── */

describe("組んで書く面の切り取り（Ctrl+X）", () => {
  /**
   * VS Code の中では Ctrl+X は `document.execCommand("cut")` として画面へ届く。
   * その**最中**に呼んだ `execCommand("delete")` を、Chromium は入れ子として
   * 断る（false を返す）。写すだけで字が消えない——作者の「Ctrl+X ができません」。
   */
  function runCut(): { deleted: boolean; note: string; calls: Array<{ command: string; nested: boolean; result: boolean }> } {
    const source = functionSource("composeCopyNotation", 'compose.addEventListener("copy"');
    const env = {
      nested: false,
      calls: [] as Array<{ command: string; nested: boolean; result: boolean }>,
      timers: [] as Array<() => void>,
      note: "",
    };
    const run = new Function(
      "env",
      `
      const COMPOSE_NOTATION_FLAVOR = "application/x-novelai-notation";
      const composeNotation = "curly";
      const composeCopyEmphasis = "kakuyomu";
      const note = {
        get textContent() { return env.note; },
        set textContent(value) { env.note = value; },
      };
      function composeSelectionNow() { return { start: 0, end: 2 }; }
      function composeCurrentAtoms() { return [{ text: "あいう" }]; }
      function composeCopyPayloads(text) { return { plain: text, html: text, notation: text }; }
      function composeRestoreCaret() {}
      function composeSend() {}
      function setTimeout(fn) { env.timers.push(fn); return env.timers.length; }
      const document = {
        execCommand(command) {
          // 入れ子（切り取りの最中）の execCommand は断られる
          const result = !env.nested;
          env.calls.push({ command, nested: env.nested, result });
          return result;
        },
      };
      ${source}
      return composeCopyNotation;
      `
    )(env) as (event: unknown, andDelete: boolean) => void;

    const data: Record<string, string> = {};
    const event = {
      clipboardData: { setData: (type: string, value: string) => (data[type] = value) },
      preventDefault() {},
    };
    // VS Code が execCommand("cut") を呼んでいる最中に、切り取りの知らせが来る
    env.nested = true;
    run(event, true);
    env.nested = false;
    for (const timer of env.timers.splice(0)) timer();
    const deleted = env.calls.some((call) => call.command === "delete" && call.result);
    expect(data["text/plain"]).toBe("あい");
    return { deleted, note: env.note, calls: env.calls };
  }

  it("**切り取りの最中に断られても、終わってから消す**", () => {
    const result = runCut();
    expect(result.deleted, "写すだけで字が消えていない").toBe(true);
  });
});
