/**
 * 原稿エディターの右傍線の入力欄のつなぎ（`views/manuscriptEditorHtml.ts` の rline の塊。
 * 設計書6.25.2 の【裁定】2026-11-16 夜）。
 *
 * - **既定（左）では何も変わらない**：入力欄を選び直す処理が、左のままなら打つ面・組んで書く面に
 *   一切触らないこと。右でも、横書き・EditContext の無い環境では今までの面のままのこと
 * - 右の入力欄は**打つ面と同じ道で送る**（send を呼ぶ。edit の知らせを自分で作らない）
 * - 組んで書く面から入っても、組んで書くの覚えを消さない
 *
 * 塊を台本から切り出し、画面の部品を作り物にして動かす。
 */
import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

const html = buildManuscriptEditorHtml("nonce", "csp");
const code = html.slice(html.indexOf("<script"));
const block = code.slice(code.indexOf("/* rline:start */"), code.indexOf("/* rline:end */"));

interface Harness {
  refresh(): void;
  setSetting(value: string): void;
  setVertical(value: boolean): void;
  isOn(): boolean;
  takeIncoming(text: string): void;
  typed(text: string): void;
  calls: string[];
  bodyClasses: Set<string>;
  composeWanted(): boolean;
  writeValue(): string;
}

/** 塊を作り物の画面の上で動かす */
function harness(options: { editContext: boolean; composeOn: boolean }): Harness {
  const calls: string[] = [];
  const bodyClasses = new Set<string>();
  const run = new Function(
    "calls",
    "bodyClasses",
    "withEditContext",
    "startCompose",
    `
    const listeners = {};
    const element = {
      style: {},
      dataset: {},
      innerHTML: "",
      setAttribute() {},
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100 }; },
      focus() { calls.push("rline.focus"); },
      scrollLeft: 0,
      scrollTop: 0,
    };
    const document = {
      getElementById(id) { return id === "rline" ? element : null; },
      body: { classList: { add(c) { bodyClasses.add(c); }, remove(c) { bodyClasses.delete(c); } } },
      activeElement: null,
    };
    let contextText = null;
    function FakeContext(init) {
      contextText = init.text;
      this.addEventListener = function (type, fn) { (listeners["ec:" + type] = listeners["ec:" + type] || []).push(fn); };
      this.updateText = function (s, e, t) { calls.push("ec.updateText"); };
      this.updateSelection = function () {};
      this.updateControlBounds = function () {};
      this.updateSelectionBounds = function () {};
      this.updateCharacterBounds = function () {};
    }
    const window = withEditContext ? { EditContext: FakeContext, addEventListener() {} } : { addEventListener() {} };
    const vscode = { postMessage(m) { calls.push("post:" + m.type); } };
    const note = { textContent: "" };
    function watchImeEnter() { return function () { return false; }; }
    let vertical = true;
    let updateTaken = true;
    let composeOn = startCompose;
    let composeWanted = false;
    let current = "朝の駅";
    const write = {
      value: "朝の駅",
      selectionStart: 0,
      selectionEnd: 0,
      focus() { calls.push("write.focus"); },
      setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    };
    function composeSelectionNow() { return { start: 1, end: 1 }; }
    function composeLeave() { calls.push("composeLeave"); composeOn = false; }
    function composeEnter() { calls.push("composeEnter"); composeOn = true; }
    function aloudFinish() {}
    function send() { if (write.value === current) return; current = write.value; calls.push("send:" + write.value); }
    function isOwnEcho() { return false; }
    function forgetSent() { calls.push("forgetSent"); }
    function setEditBase() {}
    function logRebuildFromIncoming() {}
    function setTimeout(fn) { fn(); }
    ${block}
    return {
      refresh: rlRefresh,
      setSetting(v) { rlSetting = v; },
      setVertical(v) { vertical = v; },
      isOn() { return rlOn; },
      takeIncoming: rlTakeIncoming,
      typed(t) {
        for (const fn of listeners["ec:textupdate"] || []) {
          fn({ updateRangeStart: contextText.length, updateRangeEnd: contextText.length, text: t, selectionStart: contextText.length + t.length });
        }
      },
      composeWanted() { return composeWanted; },
      writeValue() { return write.value; },
    };
    `
  );
  const api = run(calls, bodyClasses, options.editContext, options.composeOn);
  return { ...api, calls, bodyClasses };
}

describe("右傍線の入力欄のつなぎ", () => {
  it("塊が台本に入っている（中身は core/rightImeLineScript.ts）", () => {
    expect(block.length).toBeGreaterThan(0);
    expect(code).toContain("function rlCreateSession(");
    expect(html).toContain('<div id="rline"');
  });

  it("既定（左）では、選び直しても打つ面・組んで書く面に触らない", () => {
    const h = harness({ editContext: true, composeOn: true });
    h.refresh();
    expect(h.isOn()).toBe(false);
    expect(h.bodyClasses.size).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("右を選んでも、横書きでは今までの面のまま", () => {
    const h = harness({ editContext: true, composeOn: false });
    h.setSetting("right");
    h.setVertical(false);
    h.refresh();
    expect(h.isOn()).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("EditContext が無ければ今までの面のまま。理由は1回だけ出す", () => {
    const h = harness({ editContext: false, composeOn: false });
    h.setSetting("right");
    h.refresh();
    h.refresh();
    expect(h.isOn()).toBe(false);
    expect(h.calls).toEqual(["post:log"]);
  });

  it("縦書きで右を選ぶと右の入力欄へ。組んで書くの覚えは残し、横書きにすると組んで書くへ戻る", () => {
    const h = harness({ editContext: true, composeOn: true });
    h.setSetting("right");
    h.refresh();
    expect(h.isOn()).toBe(true);
    expect(h.bodyClasses.has("rline")).toBe(true);
    expect(h.calls).toContain("composeLeave");
    // 組んで書くの望みを残したまま（remember が compose: true を覚える）
    expect(h.composeWanted()).toBe(true);

    h.setVertical(false);
    h.refresh();
    expect(h.isOn()).toBe(false);
    expect(h.bodyClasses.has("rline")).toBe(false);
    expect(h.calls.at(-1)).toBe("composeEnter");
    expect(h.composeWanted()).toBe(false);
  });

  it("打った字は打つ面の値を揃えて send で送る（同じ道）", () => {
    const h = harness({ editContext: true, composeOn: false });
    h.setSetting("right");
    h.refresh();
    h.typed("は");
    expect(h.writeValue()).toBe("朝の駅は");
    expect(h.calls).toContain("send:朝の駅は");
    // 塊は edit の知らせを自分で作らない
    expect(block).not.toContain('type: "edit"');
  });

  it("外から届いた本文は打つ面の値にも入れる", () => {
    const h = harness({ editContext: true, composeOn: false });
    h.setSetting("right");
    h.refresh();
    h.takeIncoming("夜の駅");
    expect(h.writeValue()).toBe("夜の駅");
    expect(h.calls).toContain("forgetSent");
  });

  it("本文の便を受ける所：右の入力欄にいないときは今までどおり takeIncoming", () => {
    expect(code).toContain(
      "} else if (rlOn) rlTakeIncoming(message.text, undoCaret);\n      else takeIncoming(message.text, undoCaret);"
    );
    expect(code).toContain("if (composeWanted && !composeOn && !rlOn) {");
  });
});
