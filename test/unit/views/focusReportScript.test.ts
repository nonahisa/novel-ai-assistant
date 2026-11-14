/**
 * パネルが押さずに焦点を受けたことを知らせる部品（`views/focusReportScript.ts`。2026-11-14）。
 *
 * 埋め込む JavaScript を、作り物の窓（window）の上で動かして確かめる。
 * 決まりは原稿エディター（0.152.1）と同じ：
 * - 押している間（pointerdown から pointerup の直後まで）に受けた焦点は知らせない
 * - 中の欄が受けた焦点（target が窓でない）は知らせない
 * - 押さずに窓が受けた焦点は、受けるたびに1回知らせる（1つの窓で何回戻すかは拡張機能が決める）
 */
import { describe, expect, it } from "vitest";
import { REPORT_FOCUS_WITHOUT_POINTER_SOURCE, reportFocusWithoutPointerScript } from "../../../src/views/focusReportScript";

type Listener = (event: { target: unknown }) => void;

function setup() {
  const listeners = new Map<string, Listener[]>();
  const win = {
    addEventListener(type: string, listener: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  const pending: Array<() => void> = [];
  let sent = 0;
  const run = new Function("win", "send", "later", `${REPORT_FOCUS_WITHOUT_POINTER_SOURCE}\nreportFocusWithoutPointer(win, send, later);`) as (
    win: unknown,
    send: () => void,
    later: (callback: () => void) => void
  ) => void;
  run(
    win,
    () => {
      sent++;
    },
    (callback) => pending.push(callback)
  );
  const fire = (type: string, target: unknown = win) => {
    for (const listener of listeners.get(type) ?? []) listener({ target });
  };
  return {
    win,
    fire,
    sent: () => sent,
    /** pointerup のあとに置いた「直後」を流す */
    flush: () => {
      while (pending.length > 0) pending.shift()?.();
    },
  };
}

describe("reportFocusWithoutPointer（押さずに受けた焦点を知らせる）", () => {
  it("押さずに窓が焦点を受けたら、1回知らせる", () => {
    const s = setup();
    s.fire("focus");
    expect(s.sent()).toBe(1);
    s.fire("focus");
    expect(s.sent()).toBe(2);
  });

  it("押している間に受けた焦点は知らせない（押し終わりの直後まで作者のもの）", () => {
    const s = setup();
    s.fire("pointerdown");
    s.fire("focus");
    s.fire("pointerup");
    s.fire("focus");
    expect(s.sent()).toBe(0);
    s.flush();
    s.fire("focus");
    expect(s.sent()).toBe(1);
  });

  it("中の欄が受けた焦点（target が窓でない）は知らせない", () => {
    const s = setup();
    s.fire("focus", { tagName: "TEXTAREA" });
    expect(s.sent()).toBe(0);
  });

  it("テンプレートリテラルを壊す字を含まない", () => {
    expect(REPORT_FOCUS_WITHOUT_POINTER_SOURCE).not.toContain("`");
    expect(REPORT_FOCUS_WITHOUT_POINTER_SOURCE).not.toContain("${");
  });

  it("置く形は、渡した変数名で focusWithoutPointer を送る", () => {
    const script = reportFocusWithoutPointerScript("vscode");
    expect(script).toContain('vscode.postMessage({ type: "focusWithoutPointer" })');
    expect(() => new Function("window", "vscode", script)).not.toThrow();
  });
});
