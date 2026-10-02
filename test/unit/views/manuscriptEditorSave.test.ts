import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 原稿エディターの［保存］ボタン（作者の裁定、2026-10-01。設計書6.25.9）。
 *
 * 拡張機能ホストが起動し直して画面の受け手が居なくなると、打った字が届かない
 * まま残る（2026-10-01 ノートPCで約100字）。画面は自分でファイルを書けないが、
 * **保存できたかを確実に知らせる**ことはできる。
 *
 * ここでは画面へ渡る本物のスクリプト（届いたかを確かめる仕組み unsent と、
 * 保存ボタン saveButton の2つの区切り）を切り出して動かす
 * （manuscriptEditorUnsent.test.ts と同じやり方）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

function markedBlock(name: string): string {
  const start = code.indexOf(`/* ${name}:start */`);
  const end = code.indexOf(`/* ${name}:end */`);
  if (start < 0 || end < 0) return "";
  return code.slice(start, end);
}

interface FakeClassList {
  add(name: string): void;
  remove(name: string): void;
  contains(name: string): boolean;
}

function fakeClassList(): FakeClassList {
  const names = new Set<string>();
  return {
    add: (name) => names.add(name),
    remove: (name) => names.delete(name),
    contains: (name) => names.has(name),
  };
}

interface Harness {
  click(id: string): void;
  receive(message: Record<string, unknown>): void;
  update(message: Record<string, unknown>): void;
  advance(ms: number): void;
  posted(): Array<Record<string, unknown>>;
  /** 画面で押したキー（document の keydown を順に呼ぶ） */
  key(init: Record<string, unknown>): void;
  note(): string;
  failOpen(): boolean;
  failText(): string;
  clipboard(): string;
  state(): Record<string, unknown> | undefined;
}

function harness(options: { composeOn?: boolean; text?: string } = {}): Harness {
  const unsent = markedBlock("unsent");
  const save = markedBlock("saveButton");
  expect(unsent, "届いたかを確かめる仕組み（unsent）が画面に無い").not.toBe("");
  expect(save, "保存ボタンの仕組み（saveButton）が画面に無い").not.toBe("");
  const env = {
    now: 0,
    timers: [] as Array<{ at: number; fn: () => void; id: number }>,
    nextId: 1,
    posted: [] as Array<Record<string, unknown>>,
    noteText: "",
    text: options.text ?? "打った字",
    composeOn: options.composeOn ?? true,
    store: {} as { state?: unknown },
    clicks: {} as Record<string, () => void>,
    keydowns: [] as Array<(event: Record<string, unknown>) => void>,
    elements: {} as Record<string, Record<string, unknown>>,
    clipboard: "",
    lastBox: null as null | { value: string },
  };
  const api = new Function(
    "env",
    "fakeClassList",
    `
    let composing = false;
    let pending = null;
    let composePending = null;
    let composeOn = env.composeOn;
    const vscode = {
      postMessage: (message) => env.posted.push(JSON.parse(JSON.stringify(message))),
      getState: () =>
        env.store.state === undefined ? undefined : JSON.parse(JSON.stringify(env.store.state)),
      setState: (value) => { env.store.state = JSON.parse(JSON.stringify(value)); },
    };
    const note = {
      get textContent() { return env.noteText; },
      set textContent(value) { env.noteText = value; },
    };
    function element(id) {
      if (!env.elements[id]) {
        env.elements[id] = {
          id,
          hidden: false,
          disabled: false,
          textContent: "",
          title: "",
          classList: fakeClassList(),
          addEventListener: (type, fn) => { if (type === "click") env.clicks[id] = fn; },
        };
      }
      return env.elements[id];
    }
    const unsentBar = element("unsent");
    const unsentText = element("unsentText");
    const unsentCopyButton = element("unsentCopy");
    const unsentReopenButton = element("unsentReopen");
    const rescueBar = element("rescue");
    const rescueText = element("rescueText");
    const rescueRestoreButton = element("rescueRestore");
    const rescueDiscardButton = element("rescueDiscard");
    const rescueCopyButton = element("rescueCopy");
    const Date = { now: () => env.now };
    function setTimeout(fn, ms) {
      const id = env.nextId++;
      env.timers.push({ at: env.now + (ms || 0), fn, id });
      return id;
    }
    function clearTimeout(id) {
      env.timers = env.timers.filter((timer) => timer.id !== id);
    }
    const window = { addEventListener: () => {} };
    const document = {
      visibilityState: "visible",
      addEventListener: (type, fn) => { if (type === "keydown") env.keydowns.push(fn); },
      getElementById: (id) => element(id),
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
    function composeSend(force) {
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
    ${unsent}
    ${save}
    return {
      receive: (message) => {
        // 本体の受け口と同じ振り分け（editApplied は takeEditApplied へも渡す）
        if (message.type === "editApplied") takeEditApplied(message);
        takeSaveMessage(message);
      },
      update: (message) => { current = message.text; rescueTakeUpdate(message); },
    };
    `
  )(env, fakeClassList) as {
    receive(message: Record<string, unknown>): void;
    update(message: Record<string, unknown>): void;
  };

  return {
    click: (id) => {
      const fn = env.clicks[id];
      expect(fn, `${id} を押す受け口が無い`).toBeTypeOf("function");
      fn();
    },
    receive: (message) => api.receive(message),
    update: (message) => api.update(message),
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
    posted: () => env.posted,
    key(init) {
      const event = {
        isComposing: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault() {},
        ...init,
      };
      for (const fn of env.keydowns) fn(event);
    },
    note: () => env.noteText,
    failOpen: () =>
      (env.elements["saveFail"]?.classList as FakeClassList | undefined)?.contains("open") ===
      true,
    failText: () => String(env.elements["saveFailText"]?.textContent ?? ""),
    clipboard: () => env.clipboard,
    state: () => env.store.state as Record<string, unknown> | undefined,
  };
}

describe("画面の［保存］ボタン", () => {
  it("下の欄にある（打つ面・組んで書く面で共通の #foot）", () => {
    const foot = html.slice(html.indexOf('<div id="foot">'), html.indexOf('<div id="menu">'));
    expect(foot).toMatch(/<button id="saveCheck"[^>]*>保存<\/button>/);
    expect(foot).toMatch(/id="saveFail"/);
    // #note の直前に #unsent がある並びは崩さない（出ている間 #note を隠す CSS が隣を見ている）
    expect(foot.indexOf('id="unsent"')).toBeLessThan(foot.indexOf('id="note"'));
    expect(foot).toMatch(/<\/span>\s*<span id="note">/);
  });

  it("本体の受け口が、受付・結果・届いた返事を保存ボタンの振り分けへ渡す", () => {
    const start = code.indexOf('window.addEventListener("message"');
    const handler = code.slice(start, code.indexOf("\n  });", start));
    expect(handler).toMatch(/message\.type === "saveAccepted"[\s\S]{0,200}takeSaveMessage\(message\)/);
    expect(handler).toMatch(/takeEditApplied\(message\);[\s\S]{0,200}takeSaveMessage\(message\)/);
  });

  it("Ctrl+S でも［保存］と同じく保存を頼み、結果を下の欄に出す（作者の報告 2026-10-02「反応がない」）", () => {
    const h = harness();
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.key({ key: "s", ctrlKey: true });
    const requests = h.posted().filter((m) => m.type === "saveRequest");
    expect(requests).toHaveLength(1);
    h.receive({ type: "saveAccepted", seq: requests[0].seq });
    expect(h.note()).toBe("保存しています…");
    h.receive({ type: "saveResult", seq: requests[0].seq, ok: true, chars: 12 });
    expect(h.note()).toBe("保存しました（12字）");
  });

  it("変換中の Ctrl+S・Alt つき・ほかのキーでは保存を頼まない", () => {
    const h = harness();
    h.key({ key: "s", ctrlKey: true, isComposing: true });
    h.key({ key: "s", ctrlKey: true, altKey: true });
    h.key({ key: "a", ctrlKey: true });
    h.key({ key: "s" });
    expect(h.posted().filter((m) => m.type === "saveRequest")).toHaveLength(0);
  });

  it("受付が来たら「保存しています…」を出し、結果は3秒を過ぎても待つ", () => {
    const h = harness();
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    const seq = h.posted().find((m) => m.type === "saveRequest")?.seq;
    h.receive({ type: "saveAccepted", seq });
    expect(h.note()).toBe("保存しています…");
    // 保存に時間がかかっても「届いていません」は出さない
    h.advance(10000);
    expect(h.failOpen()).toBe(false);
    h.receive({ type: "saveResult", seq, ok: true, chars: 50 });
    expect(h.note()).toBe("保存しました（50字）");
  });

  it("受付のあと30秒たっても結果が無ければ、もう一度押すか Ctrl+S を案内する", () => {
    const h = harness();
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    const seq = h.posted().find((m) => m.type === "saveRequest")?.seq;
    h.receive({ type: "saveAccepted", seq });
    h.advance(29900);
    expect(h.failOpen()).toBe(false);
    h.advance(200);
    expect(h.failOpen()).toBe(true);
    expect(h.failText()).toMatch(/保存の返事がありません/);
    expect(h.failText()).toMatch(/もう一度［保存］を押すか、Ctrl\+S/);
    expect(h.note()).not.toBe("保存しています…");
  });

  it("「届いていません」のあと受付が遅れて来たら、赤字を下ろして保存を待つ", () => {
    const h = harness();
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    const seq = h.posted().find((m) => m.type === "saveRequest")?.seq;
    h.advance(3100);
    expect(h.failOpen()).toBe(true);
    h.receive({ type: "saveAccepted", seq });
    expect(h.failOpen()).toBe(false);
    expect(h.note()).toBe("保存しています…");
  });

  it("「届いていません」のあと打った字が届いた返事が来たら、赤字を下ろして押し直しを促す", () => {
    const h = harness();
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    h.advance(3100);
    expect(h.failOpen()).toBe(true);
    const seq = h.posted().find((m) => m.type === "edit")?.seq;
    h.receive({ type: "editApplied", seq, ok: true });
    expect(h.failOpen()).toBe(false);
    expect(h.note()).toMatch(/もう一度［保存］を押してください/);
  });

  it("「保存できなかった」の赤字は、打った字が届いただけでは下ろさない（保存できた証拠ではない）", () => {
    const h = harness();
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    const seq = h.posted().find((m) => m.type === "saveRequest")?.seq;
    h.receive({ type: "saveAccepted", seq });
    h.receive({ type: "saveResult", seq, ok: false, reason: "読み取り専用のファイルです" });
    h.receive({ type: "editApplied", seq, ok: true });
    expect(h.failOpen()).toBe(true);
  });

  for (const composeOn of [true, false]) {
    const face = composeOn ? "組んで書く面" : "打つ面";
    it(`${face}：押すと、いまの本文を edit で送ってから、その便の番号で保存を頼む`, () => {
      const h = harness({ composeOn, text: "百字の本文" });
      h.update({ type: "update", docKey: "doc", text: "古い本文" });
      h.click("saveCheck");
      const posted = h.posted();
      const editIndex = posted.findIndex((m) => m.type === "edit");
      const saveIndex = posted.findIndex((m) => m.type === "saveRequest");
      expect(editIndex, "本文を送っていない").toBeGreaterThanOrEqual(0);
      expect(saveIndex, "保存を頼んでいない").toBeGreaterThan(editIndex);
      expect(posted[editIndex].text).toBe("百字の本文");
      expect(posted[saveIndex].seq).toBe(posted[editIndex].seq);
    });
  }

  it("押したとき、画面の控え（rescue）にも本文を控える", () => {
    const h = harness({ text: "控える本文" });
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    const rescue = h.state()?.rescue as { text?: string; docKey?: string } | undefined;
    expect(rescue?.text).toBe("控える本文");
    expect(rescue?.docKey).toBe("doc");
  });

  it("返事が来たら「保存しました（N字）」を出し、数秒で戻す", () => {
    const h = harness();
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    const seq = h.posted().find((m) => m.type === "saveRequest")?.seq;
    h.receive({ type: "editApplied", seq, ok: true });
    h.receive({ type: "saveResult", seq, ok: true, chars: 1234 });
    expect(h.note()).toBe("保存しました（1234字）");
    expect(h.failOpen()).toBe(false);
    h.advance(3000);
    // 3秒たっても見えている（すぐ消えると読めない）
    expect(h.note()).toBe("保存しました（1234字）");
    h.advance(10000);
    expect(h.note()).toBe("");
  });

  it("3秒たっても受付が無ければ、保存できなかったと赤字で出し、コピーと再読み込みを案内する", () => {
    const h = harness({ text: "届かない本文" });
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    h.advance(2900);
    expect(h.failOpen()).toBe(false);
    h.advance(200);
    expect(h.failOpen()).toBe(true);
    expect(h.failText()).toMatch(/保存できませんでした（拡張機能に届いていません）/);
    expect(h.failText()).toMatch(/ウィンドウの再読み込み/);
    expect(h.failText()).toMatch(/タブを閉じると/);
    // 操作ログへ1行（届かないかもしれないが、届けば残る）
    expect(
      h.posted().some((m) => m.type === "log" && /保存/.test(String(m.text)))
    ).toBe(true);
    // ［本文をコピー］は拡張機能を通さず写す
    h.click("saveFailCopy");
    expect(h.clipboard()).toBe("届かない本文");
    // 控えは残っている（取り戻せる）
    expect((h.state()?.rescue as { text?: string } | undefined)?.text).toBe("届かない本文");
  });

  it("「保存できなかった」と返ってきたら、理由と次の手を出す", () => {
    const h = harness();
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    const seq = h.posted().find((m) => m.type === "saveRequest")?.seq;
    h.receive({ type: "saveResult", seq, ok: false, reason: "読み取り専用のファイルです" });
    expect(h.failOpen()).toBe(true);
    expect(h.failText()).toMatch(/保存できませんでした/);
    expect(h.failText()).toMatch(/読み取り専用のファイルです/);
    expect(h.failText()).toMatch(/本文をコピー/);
  });

  it("遅れて「保存できた」が届いたら、赤字を下ろして「保存しました」に変える", () => {
    const h = harness();
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    const seq = h.posted().find((m) => m.type === "saveRequest")?.seq;
    h.advance(3500);
    expect(h.failOpen()).toBe(true);
    h.receive({ type: "saveResult", seq, ok: true, chars: 9 });
    expect(h.failOpen()).toBe(false);
    expect(h.note()).toBe("保存しました（9字）");
  });

  it("前に押した分の返事は、あとで押した分の結果として扱わない", () => {
    const h = harness();
    h.update({ type: "update", docKey: "doc", text: "古い本文" });
    h.click("saveCheck");
    const first = h.posted().filter((m) => m.type === "saveRequest")[0]?.seq;
    h.click("saveCheck");
    h.receive({ type: "saveResult", seq: first, ok: true, chars: 1 });
    expect(h.note()).toBe("");
    h.advance(3100);
    expect(h.failOpen()).toBe(true);
  });
});
