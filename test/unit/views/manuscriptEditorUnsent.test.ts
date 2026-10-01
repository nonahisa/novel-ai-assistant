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
  /** 拡張機能から届いた本文（update）を受ける */
  update(message: Record<string, unknown>): void;
  /** 画面のボタンを押す（unsentCopy・unsentReopen・rescueRestore など） */
  click(name: string): void;
  button(name: string): { hidden: boolean; disabled: boolean; textContent: string };
  unsentText(): string;
  rescueOpen(): boolean;
  rescueText(): string;
  posted(): Array<Record<string, unknown>>;
  clipboard(): string;
  now(): number;
}

/** 画面の状態（vscode.setState）の置き場。画面を作り直しても同じ物を渡す */
interface StateStore {
  state?: unknown;
}

function unsentHarness(
  options: { composeOn?: boolean; text?: string; store?: StateStore; now?: number } = {}
): UnsentHarness {
  const block = markedBlock("unsent");
  expect(block, "届いたかを確かめる仕組み（unsent）が画面に無い").not.toBe("");
  const store: StateStore = options.store ?? {};
  const env = {
    now: options.now ?? 0,
    timers: [] as Array<{ at: number; fn: () => void; id: number }>,
    nextId: 1,
    posted: [] as Array<{ type: string; text?: string; seq?: number }>,
    windowHandlers: {} as Record<string, Array<(event: unknown) => void>>,
    documentHandlers: {} as Record<string, Array<(event: unknown) => void>>,
    bar: fakeClassList(),
    rescueBar: fakeClassList(),
    noteText: "",
    forced: 0,
    text: options.text ?? "打った字",
    composeOn: options.composeOn ?? true,
    visibility: "visible",
    store,
    clicks: {} as Record<string, () => void>,
    buttons: {} as Record<string, { hidden: boolean; disabled: boolean; textContent: string }>,
    unsentText: { textContent: "" },
    rescueText: { textContent: "" },
    clipboard: "",
    lastBox: null as null | { value: string },
  };
  const api = new Function(
    "env",
    `
    let composing = false;
    let pending = null;
    let composePending = null;
    let composeOn = env.composeOn;
    // 画面の状態は JSON で写して持つ（VS Code も直列化して持つ）
    const vscode = {
      postMessage: (message) => env.posted.push(message),
      getState: () =>
        env.store.state === undefined ? undefined : JSON.parse(JSON.stringify(env.store.state)),
      setState: (value) => { env.store.state = JSON.parse(JSON.stringify(value)); },
    };
    const note = {
      get textContent() { return env.noteText; },
      set textContent(value) { env.noteText = value; },
    };
    function fakeButton(name) {
      const button = {
        hidden: false,
        disabled: false,
        textContent: "",
        title: "",
        addEventListener: (type, fn) => { if (type === "click") env.clicks[name] = fn; },
      };
      env.buttons[name] = button;
      return button;
    }
    const unsentBar = { classList: env.bar };
    const unsentText = env.unsentText;
    const unsentCopyButton = fakeButton("unsentCopy");
    const unsentReopenButton = fakeButton("unsentReopen");
    const rescueBar = { classList: env.rescueBar };
    const rescueText = env.rescueText;
    const rescueRestoreButton = fakeButton("rescueRestore");
    const rescueDiscardButton = fakeButton("rescueDiscard");
    const rescueCopyButton = fakeButton("rescueCopy");
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
      // 「本文をコピー」が使う写し方（隠した textarea を選んで copy）
      createElement: () => ({ value: "", style: {}, select() {} }),
      body: {
        appendChild: (box) => { env.lastBox = box; },
        removeChild: () => {},
      },
      execCommand: (command) => {
        if (command !== "copy" || env.lastBox === null) return false;
        env.clipboard = env.lastBox.value;
        return true;
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
    function composeApplyText(text) { env.text = text; }
    const compose = {};
    const write = {
      get value() { return env.text; },
      set value(text) { env.text = text; },
    };
    ${block}
    return {
      postEdit: (text) => { current = text; postEdit(text); },
      receive: (message) => {
        if (message && message.type === "reopenAccepted") takeReopenReply(message);
        else if (message && message.type === "reopenResult") takeReopenReply(message);
        else takeEditApplied(message);
      },
      update: (message) => { current = message.text; rescueTakeUpdate(message); },
      setComposing: (value) => { composing = value; },
      composing: () => composing,
    };
    `
  )(env) as {
    postEdit(text: string): void;
    receive(message: unknown): void;
    update(message: Record<string, unknown>): void;
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
    update: (message) => api.update(message),
    click(name) {
      const button = env.buttons[name];
      expect(button, `${name} のボタンが無い`).toBeDefined();
      // 押せないボタンは押しても何も起きない（本物の disabled と同じ）
      if (button.disabled || button.hidden) return;
      const fn = env.clicks[name];
      expect(fn, `${name} を押したときの動きが無い`).toBeDefined();
      fn();
    },
    button: (name) => env.buttons[name],
    unsentText: () => env.unsentText.textContent,
    rescueOpen: () => env.rescueBar.contains("open"),
    rescueText: () => env.rescueText.textContent,
    posted: () => env.posted as Array<Record<string, unknown>>,
    clipboard: () => env.clipboard,
    now: () => env.now,
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

  /*
    作者の依頼（2026-10-01）：上の赤い帯を、下の欄の「打った字が原稿に
    入りました」と同じ場所へ赤字で出す。上に帯が出ると本文が押し下がり、
    書いている行が動く。
  */
  it("**知らせは下の欄（#foot）に、「原稿に入りました」と同じ場所へ出す**", () => {
    const foot = html.slice(html.indexOf('<div id="foot">'), html.indexOf("</div>", html.indexOf('<div id="foot">')));
    expect(foot).toContain('id="unsent"');
    expect(foot).toContain('role="alert"');
    expect(foot).toContain('id="unsentCopy"');
    // 「入りました」の #note の直前に置く（出ている間は #note の場所を使う）
    expect(foot.indexOf('id="unsent"')).toBeLessThan(foot.indexOf('id="note"'));
    // 上の帯（本文の上）には、もう置かない
    const surface = html.indexOf('<div id="surface">');
    expect(html.indexOf('id="unsent"')).toBeGreaterThan(surface);
  });

  it("赤字はテーマの色から取る（暗いテーマでも読める）", () => {
    const css = html.slice(html.indexOf("#unsent {"), html.indexOf("}", html.indexOf("#unsent {")));
    expect(css).toContain("var(--vscode-errorForeground");
    // 帯（背景の塗り）にはしない
    expect(css).not.toContain("background:");
  });

  it("**知らせを出したとき・下ろしたときに、記録へ1行ずつ残す**（いつ出たかを後から確かめる）", () => {
    const h = unsentHarness();
    h.postEdit("打った字");
    h.advance(5_000);
    expect(h.bannerOpen()).toBe(true);
    // 送り直しても、出したままなら記録は増やさない
    h.advance(10_000);
    const shown = h.logs().filter((text) => /知らせを出しました/.test(text));
    expect(shown, "出したときの記録が無い").toHaveLength(1);
    expect(shown[0]).toMatch(/返事が\d+秒/);

    const last = h.edits().at(-1)!;
    h.receive({ type: "editApplied", seq: last.seq, ok: true });
    const hidden = h.logs().filter((text) => /知らせを下ろしました/.test(text));
    expect(hidden, "下ろしたときの記録が無い").toHaveLength(1);
  });

  it("入れられなかったと返ってきたときは、その理由で記録する", () => {
    const h = unsentHarness();
    h.postEdit("あ");
    h.receive({ type: "editApplied", seq: 1, ok: false });
    expect(h.logs().some((text) => /知らせを出しました/.test(text) && /入れられなかった/.test(text))).toBe(true);
  });

  it("出ていないときに届いた返事では、下ろした記録を書かない", () => {
    const h = unsentHarness();
    h.postEdit("あ");
    h.receive({ type: "editApplied", seq: 1, ok: true });
    expect(h.logs()).toEqual([]);
  });
});

/* ── 知らせを段階で出す（作者の裁定 2026-10-01「段階で出す」）───────── */

/*
  実際に起きたこと（2026-10-01、ノートPC、0.94.0）：拡張機能ホストが
  起動し直したあと、画面で打った約100字が一度もファイルへ届かなかった。
  知らせと「本文をコピー」は出ていたが、作者の声は「消えない。製品版だと
  どう対処するのか。ユーザーが対応に迷いそう」。
*/
describe("届かない知らせを段階で出す", () => {
  it("**出た直後は「送り直しています（N秒）」と数え上げる**", () => {
    const h = unsentHarness();
    h.postEdit("打った字");
    h.advance(5_000);
    expect(h.bannerOpen()).toBe(true);
    expect(h.unsentText()).toMatch(/打った字を原稿へ送り直しています（\d+秒）/);
    const first = Number(/（(\d+)秒）/.exec(h.unsentText())![1]);
    h.advance(10_000);
    const later = Number(/（(\d+)秒）/.exec(h.unsentText())![1]);
    expect(later - first, "秒数が数え上がっていない").toBeGreaterThanOrEqual(9);
    // 出た直後から「本文をコピー」は押せる。［開き直す］はまだ出さない
    expect(h.button("unsentReopen").hidden).toBe(true);
  });

  it("**30秒たっても消えなければ、「入りません」の段に変えて［開き直す］を並べる**", () => {
    const h = unsentHarness();
    h.postEdit("打った字");
    // 知らせは4秒で出る。そこから数えて29秒
    h.advance(4_000);
    expect(h.bannerOpen()).toBe(true);
    h.advance(29_000);
    expect(h.unsentText(), "まだ30秒たっていない").toMatch(/送り直しています/);
    h.advance(2_000);
    expect(h.unsentText()).toContain(
      "打った字が原稿に入りません。本文をコピーで控えてから、開き直してください。"
    );
    expect(h.button("unsentReopen").hidden).toBe(false);
    // 段が変わったことを記録へ残す
    expect(h.logs().some((text) => /開き直す案内/.test(text))).toBe(true);
  });

  it("**［開き直す］はコピーを済ませるまで押せない**（押すと画面の字が消えるため）", () => {
    const h = unsentHarness({ text: "控えたい字" });
    h.postEdit("控えたい字");
    h.advance(40_000);
    expect(h.button("unsentReopen").disabled).toBe(true);
    h.click("unsentReopen");
    expect(h.posted().some((message) => message.type === "reopen")).toBe(false);

    h.click("unsentCopy");
    expect(h.clipboard()).toBe("控えたい字");
    // コピー後の文は今までどおり
    expect(h.unsentText()).toContain("クリップボードへ写しました");
    expect(h.button("unsentReopen").disabled).toBe(false);
    // 秒の数え上げでコピー後の文を上書きしない
    h.advance(5_000);
    expect(h.unsentText()).toContain("クリップボードへ写しました");
  });

  it("**［開き直す］は拡張機能へ頼む。返事が来なければ、自分で開き直す手順を文で案内する**", () => {
    const h = unsentHarness({ text: "控えたい字" });
    h.update({ type: "update", docKey: "k", text: "元" });
    h.postEdit("控えたい字");
    h.advance(40_000);
    h.click("unsentCopy");
    h.click("unsentReopen");
    const asked = h.posted().filter((message) => message.type === "reopen");
    expect(asked).toHaveLength(1);
    // 拡張機能が生きていれば、新しい画面へ控えを持って行けるように添える
    expect((asked[0].rescue as { text: string }).text).toBe("控えたい字");
    h.advance(5_000);
    expect(h.unsentText()).toMatch(/ウィンドウの再読み込み/);
    expect(h.logs().some((text) => /開き直し/.test(text) && /返事/.test(text))).toBe(true);
  });

  it("拡張機能が開き直しを受けたなら、自分で開き直す案内は出さない", () => {
    const h = unsentHarness({ text: "控えたい字" });
    h.update({ type: "update", docKey: "k", text: "元" });
    h.postEdit("控えたい字");
    h.advance(40_000);
    h.click("unsentCopy");
    h.click("unsentReopen");
    h.receive({ type: "reopenAccepted" });
    h.advance(5_000);
    expect(h.unsentText()).not.toMatch(/ウィンドウの再読み込み/);
    expect(h.unsentText()).toMatch(/開き直しています/);
  });

  it("届いて知らせを下ろしたら、段も［開き直す］も元へ戻す", () => {
    const h = unsentHarness();
    h.postEdit("打った字");
    h.advance(40_000);
    const last = h.edits().at(-1)!;
    h.receive({ type: "editApplied", seq: last.seq, ok: true });
    expect(h.bannerOpen()).toBe(false);
    expect(h.button("unsentReopen").hidden).toBe(true);
    // 次に出たときは、また1段目から
    h.postEdit("打った字を足した");
    h.advance(5_000);
    expect(h.unsentText()).toMatch(/送り直しています/);
  });
});

/* ── 開き直したときに取り戻す ─────────────────────────── */

describe("開き直したときに、原稿に入らなかった字を取り戻す", () => {
  const DOC = "元の本文";
  const TYPED = "元の本文に打ち足した字";

  /** 返事の来ない便があるまま、画面が消える（拡張機能ホストが起き直した） */
  function lostScreen(store: StateStore, now = 0): UnsentHarness {
    const h = unsentHarness({ store, text: TYPED, now });
    h.update({ type: "update", docKey: "doc-1", text: DOC });
    h.postEdit(TYPED);
    h.advance(5_000);
    return h;
  }

  it("**返事の来ない便があるまま画面を作り直すと、控えから取り戻しの案内が出る**", () => {
    const store: StateStore = {};
    lostScreen(store);
    const reopened = unsentHarness({ store, text: DOC, now: 60_000 });
    reopened.update({ type: "update", docKey: "doc-1", text: DOC });
    expect(reopened.rescueOpen(), "控えがあるのに案内が出ない").toBe(true);
    expect(reopened.rescueText()).toContain("前回、原稿に入らなかった字があります");
    expect(reopened.rescueText()).toContain("7字の差");
    // **黙って書き戻さない**
    expect(reopened.edits()).toEqual([]);
  });

  it("**返事が来れば、控えは消える**", () => {
    const store: StateStore = {};
    const h = lostScreen(store);
    expect((store.state as { rescue?: unknown }).rescue, "控えていない").toBeDefined();
    const last = h.edits().at(-1)!;
    h.receive({ type: "editApplied", seq: last.seq, ok: true });
    expect((store.state as { rescue?: unknown }).rescue).toBeUndefined();

    const reopened = unsentHarness({ store, text: TYPED, now: 60_000 });
    reopened.update({ type: "update", docKey: "doc-1", text: TYPED });
    expect(reopened.rescueOpen()).toBe(false);
  });

  it("返事がすぐ来るふだんの打鍵では、控えを書かない（打つたびに本文を写さない）", () => {
    const store: StateStore = {};
    const h = unsentHarness({ store, text: TYPED });
    h.update({ type: "update", docKey: "doc-1", text: DOC });
    h.postEdit(TYPED);
    h.receive({ type: "editApplied", seq: 1, ok: true });
    expect((store.state as { rescue?: unknown } | undefined)?.rescue).toBeUndefined();
  });

  it("**届いた文書の本文と同じなら、案内を出さない**（控えも片づける）", () => {
    const store: StateStore = {};
    lostScreen(store);
    const reopened = unsentHarness({ store, text: TYPED, now: 60_000 });
    reopened.update({ type: "update", docKey: "doc-1", text: TYPED });
    expect(reopened.rescueOpen()).toBe(false);
    expect((store.state as { rescue?: unknown }).rescue).toBeUndefined();
  });

  it("別の文書を開いたときは、控えを使わない", () => {
    const store: StateStore = {};
    lostScreen(store);
    const other = unsentHarness({ store, text: "別の話", now: 60_000 });
    other.update({ type: "update", docKey: "doc-2", text: "別の話" });
    expect(other.rescueOpen()).toBe(false);
  });

  it("7日より古い控えは出さない", () => {
    const store: StateStore = {};
    lostScreen(store);
    const late = unsentHarness({ store, text: DOC, now: 8 * 24 * 60 * 60 * 1000 });
    late.update({ type: "update", docKey: "doc-1", text: DOC });
    expect(late.rescueOpen()).toBe(false);
  });

  it("**［戻す］は、控えの本文をふだんの打鍵と同じ便（postEdit）で送る**", () => {
    const store: StateStore = {};
    lostScreen(store);
    const reopened = unsentHarness({ store, text: DOC, now: 60_000 });
    reopened.update({ type: "update", docKey: "doc-1", text: DOC });
    reopened.click("rescueRestore");
    expect(reopened.edits().map((edit) => edit.text)).toEqual([TYPED]);
    expect(reopened.rescueOpen()).toBe(false);
    expect((store.state as { rescue?: unknown }).rescue).toBeUndefined();
  });

  it("**控えたあとで原稿が外で変わっていたら、戻す前に確かめる**", () => {
    const store: StateStore = {};
    lostScreen(store);
    const reopened = unsentHarness({ store, text: "元の本文（外で直した）", now: 60_000 });
    reopened.update({ type: "update", docKey: "doc-1", text: "元の本文（外で直した）" });
    expect(reopened.rescueOpen()).toBe(true);
    reopened.click("rescueRestore");
    expect(reopened.edits(), "確かめずに戻した").toEqual([]);
    expect(reopened.rescueText()).toContain(
      "控えたあとで原稿が変わっています。戻すと、その変更が消えるかもしれません"
    );
    // もう一度押せば戻す
    reopened.click("rescueRestore");
    expect(reopened.edits().map((edit) => edit.text)).toEqual([TYPED]);
  });

  it("［捨てる］は、送らずに控えを消す", () => {
    const store: StateStore = {};
    lostScreen(store);
    const reopened = unsentHarness({ store, text: DOC, now: 60_000 });
    reopened.update({ type: "update", docKey: "doc-1", text: DOC });
    reopened.click("rescueDiscard");
    expect(reopened.edits()).toEqual([]);
    expect(reopened.rescueOpen()).toBe(false);
    expect((store.state as { rescue?: unknown }).rescue).toBeUndefined();
  });

  it("［本文をコピー］は控えの本文を写す（案内は閉じない）", () => {
    const store: StateStore = {};
    lostScreen(store);
    const reopened = unsentHarness({ store, text: DOC, now: 60_000 });
    reopened.update({ type: "update", docKey: "doc-1", text: DOC });
    reopened.click("rescueCopy");
    expect(reopened.clipboard()).toBe(TYPED);
    expect(reopened.rescueOpen()).toBe(true);
  });

  it("**拡張機能が開き直したときは、拡張機能が持って来た控えでも案内を出す**", () => {
    // タブを閉じて開き直すと、画面の状態は新しい画面へ引き継がれない
    const reopened = unsentHarness({ store: {}, text: DOC, now: 60_000 });
    reopened.update({
      type: "update",
      docKey: "doc-1",
      text: DOC,
      rescue: { docKey: "doc-1", text: TYPED, at: 50_000, baseLength: DOC.length, baseHash: "" },
    });
    expect(reopened.rescueOpen()).toBe(true);
  });

  it("案内は開いたときの1回だけ判断する（打つたびに届く本文で出し直さない）", () => {
    const store: StateStore = {};
    lostScreen(store);
    const reopened = unsentHarness({ store, text: DOC, now: 60_000 });
    reopened.update({ type: "update", docKey: "doc-1", text: DOC });
    reopened.click("rescueDiscard");
    reopened.update({ type: "update", docKey: "doc-1", text: DOC });
    expect(reopened.rescueOpen()).toBe(false);
  });
});

describe("取り戻しの案内と［開き直す］が画面にある", () => {
  it("案内は本文の上に置く", () => {
    const rescue = html.indexOf('id="rescue"');
    expect(rescue).toBeGreaterThan(0);
    expect(rescue).toBeLessThan(html.indexOf('<div id="surface">'));
    for (const id of ["rescueRestore", "rescueDiscard", "rescueCopy"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('id="unsentReopen"');
  });

  it("画面の覚え（remember）が、控えを消さない", () => {
    const source = functionSource("remember", "vscode.postMessage(");
    expect(source).toContain("rescue");
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
