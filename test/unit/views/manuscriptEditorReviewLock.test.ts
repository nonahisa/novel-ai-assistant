import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 編集者が校閲中の話を、原稿エディターで書けなくする見た目（作者の裁定 2026-11-07。設計書6.25.12）。
 *
 * 0.138.0 までは、打った字を文書へ入れずに戻すだけで、枠も色も変わらなかった。作者には
 * 「書けた」ように見えた。帯と赤い枠を出し、書く面を読むだけにする。
 *
 * 画面へ渡る本物のスクリプトを切り出して動かす（manuscriptEditorUnsent.test.ts と同じやり方）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

function markedBlock(name: string): string {
  const start = code.indexOf(`/* ${name}:start */`);
  const end = code.indexOf(`/* ${name}:end */`);
  expect(start, `${name} の始まりが見つからない`).toBeGreaterThan(0);
  expect(end, `${name} の終わりが見つからない`).toBeGreaterThan(start);
  return code.slice(start, end);
}

interface FakeElement {
  textContent: string;
  readOnly: boolean;
  offsetWidth: number;
  classes: Set<string>;
  classList: {
    toggle(name: string, on: boolean): void;
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
  handlers: Record<string, Array<(event: unknown) => void>>;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  fire(type: string, event?: unknown): void;
}

function element(): FakeElement {
  const classes = new Set<string>();
  const handlers: Record<string, Array<(event: unknown) => void>> = {};
  return {
    textContent: "",
    readOnly: false,
    offsetWidth: 0,
    classes,
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    handlers,
    addEventListener(type, fn) {
      (handlers[type] ??= []).push(fn);
    },
    fire(type, event = {}) {
      for (const fn of handlers[type] ?? []) fn(event);
    },
  };
}

/** 帯の区間を、偽の DOM の上で動かす */
function runBlock(): {
  take: (message: unknown) => void;
  setComposing: (on: boolean) => void;
  write: FakeElement;
  compose: FakeElement;
  band: FakeElement;
  bandText: FakeElement;
  surface: FakeElement;
  revoke: FakeElement;
  posted: unknown[];
  flushTimers: () => void;
} {
  const ids: Record<string, FakeElement> = {
    reviewLock: element(),
    reviewLockText: element(),
    surface: element(),
    reviewLockRevoke: element(),
  };
  const write = element();
  const compose = element();
  const posted: unknown[] = [];
  const timers: Array<() => void> = [];
  const state = { composing: false };
  const body = markedBlock("review-lock");
  const make = new Function(
    "env",
    `
    const document = { getElementById: (id) => env.ids[id] };
    const write = env.write;
    const compose = env.compose;
    const vscode = { postMessage: (message) => env.posted.push(message) };
    const setTimeout = (fn) => env.timers.push(fn);
    let composing = false;
    ${body}
    return {
      take: takeReviewLock,
      setComposing: (on) => { composing = on; },
    };
    `
  ) as (env: unknown) => { take: (message: unknown) => void; setComposing: (on: boolean) => void };
  const api = make({ ids, write, compose, posted, timers, state });
  return {
    take: api.take,
    setComposing: api.setComposing,
    write,
    compose,
    band: ids.reviewLock!,
    bandText: ids.reviewLockText!,
    surface: ids.surface!,
    revoke: ids.reviewLockRevoke!,
    posted,
    flushTimers: () => {
      while (timers.length > 0) timers.shift()!();
    },
  };
}

/** 面へ知らせを送り、止められたか（preventDefault が呼ばれたか）を返す */
function refused(face: FakeElement, type: string, fields: Record<string, unknown>): boolean {
  let prevented = false;
  face.fire(type, {
    cancelable: true,
    ...fields,
    preventDefault: () => {
      prevented = true;
    },
    stopImmediatePropagation: () => undefined,
    stopPropagation: () => undefined,
  });
  return prevented;
}

const LOCKED_TEXT ="この話は校閲中です（編集者 kmizu・11月7日 18:30 から）。編集者が返すと書けます。";

describe("校閲中の帯と赤い枠", () => {
  it("台本は JavaScript として読める", () => {
    const start = code.indexOf(">") + 1;
    const end = code.indexOf("</script>");
    expect(() => new Function(code.slice(start, end))).not.toThrow();
  });

  it("帯と［連携を解除…］がある", () => {
    expect(html).toContain('<div id="reviewLock" role="alert">');
    expect(html).toContain(">連携を解除…</button>");
    // 赤い枠は縦書き・横書きどちらの面にも付く
    expect(html).toContain("#surface.review-locked #write");
    expect(html).toContain("#surface.review-locked #compose");
  });

  it("校閲中を受けたら、帯を出し、枠を赤くし、打つ面の打鍵を止める（面は読み取り専用にしない）", () => {
    const screen = runBlock();
    screen.take({ type: "reviewLock", locked: true, text: LOCKED_TEXT });
    expect(screen.band.classes.has("open")).toBe(true);
    expect(screen.bandText.textContent).toBe(LOCKED_TEXT);
    expect(screen.surface.classes.has("review-locked")).toBe(true);
    // readOnly の textarea は Chromium でキャレットを描かない（0.140.1。Mac の実機で見えなかった）
    expect(screen.write.readOnly).toBe(false);
    expect(refused(screen.write, "beforeinput", { inputType: "insertText" })).toBe(true);
  });

  it("校閲中でないを受けたら、帯と枠を消し、また打てるようにする", () => {
    const screen = runBlock();
    screen.take({ type: "reviewLock", locked: true, text: LOCKED_TEXT });
    screen.take({ type: "reviewLock", locked: false });
    expect(screen.band.classes.has("open")).toBe(false);
    expect(screen.bandText.textContent).toBe("");
    expect(screen.surface.classes.has("review-locked")).toBe(false);
    expect(refused(screen.write, "beforeinput", { inputType: "insertText" })).toBe(false);
    expect(refused(screen.write, "keydown", { key: "あ" })).toBe(false);
  });

  it("変換の途中で届いたら、確定するまで打鍵を止めない（帯と枠は先に出す）", () => {
    const screen = runBlock();
    screen.setComposing(true);
    screen.take({ type: "reviewLock", locked: true, text: LOCKED_TEXT });
    expect(screen.band.classes.has("open")).toBe(true);
    // 確定した
    screen.setComposing(false);
    screen.write.fire("compositionend");
    screen.flushTimers();
    expect(refused(screen.write, "beforeinput", { inputType: "insertText" })).toBe(true);
  });

  it("書き換える打鍵（字・改行・消す・Tab）・貼る・切り取る・落とすを、両方の面で止める", () => {
    const screen = runBlock();
    screen.take({ type: "reviewLock", locked: true, text: LOCKED_TEXT });
    for (const face of [screen.write, screen.compose]) {
      for (const key of ["a", "あ", "Enter", "Backspace", "Delete", "Tab"]) {
        expect(refused(face, "keydown", { key }), `キー ${key}`).toBe(true);
      }
      for (const type of ["paste", "cut", "drop"]) {
        expect(refused(face, type, {}), type).toBe(true);
      }
      expect(refused(face, "beforeinput", { inputType: "historyUndo" }), "元に戻す").toBe(true);
    }
  });

  it("カーソルの移動・選択・写す・変換の途中のキーは止めない", () => {
    const screen = runBlock();
    screen.take({ type: "reviewLock", locked: true, text: LOCKED_TEXT });
    for (const face of [screen.write, screen.compose]) {
      expect(refused(face, "keydown", { key: "ArrowDown" })).toBe(false);
      expect(refused(face, "keydown", { key: "ArrowLeft", shiftKey: true })).toBe(false);
      expect(refused(face, "keydown", { key: "c", ctrlKey: true })).toBe(false);
      expect(refused(face, "keydown", { key: "a", metaKey: true })).toBe(false);
      // 変換を確定する Enter を止めると、変換が壊れる（確定した字は拡張機能が戻す）
      expect(refused(face, "keydown", { key: "Enter", isComposing: true })).toBe(false);
      expect(refused(face, "keydown", { key: "Process" })).toBe(false);
      expect(refused(face, "copy", {})).toBe(false);
    }
  });

  it("面を読み取り専用にする手だて（readOnly・contenteditable=false）を校閲中の区間で使わない", () => {
    const body = markedBlock("review-lock");
    expect(body).not.toMatch(/\.readOnly\s*=\s*(locked|true)/);
    expect(body).not.toMatch(/contenteditable["']?\s*,\s*["']false/);
    expect(body).not.toMatch(/contentEditable\s*=/);
    // 打鍵を止める受け口がある
    for (const type of ["beforeinput", "keydown", "paste", "cut", "drop"]) {
      expect(body, type).toContain(`"${type}"`);
    }
  });

  it("組んで書く面で打とうとしたら止めて帯を光らせる。変換の字は止めない（取り消せない）", () => {
    const screen = runBlock();
    screen.take({ type: "reviewLock", locked: true, text: LOCKED_TEXT });
    let prevented = 0;
    let stopped = 0;
    const typing = {
      cancelable: true,
      inputType: "insertText",
      preventDefault: () => prevented++,
      stopImmediatePropagation: () => stopped++,
    };
    screen.compose.fire("beforeinput", typing);
    expect(prevented).toBe(1);
    expect(stopped).toBe(1);
    expect(screen.band.classes.has("flash")).toBe(true);

    screen.compose.fire("beforeinput", {
      cancelable: false,
      inputType: "insertCompositionText",
      preventDefault: () => prevented++,
      stopImmediatePropagation: () => stopped++,
    });
    expect(prevented).toBe(1);
    expect(stopped).toBe(1);
  });

  it("校閲中でなければ、組んで書く面の打鍵は止めない", () => {
    const screen = runBlock();
    let prevented = 0;
    screen.compose.fire("beforeinput", {
      cancelable: true,
      inputType: "insertText",
      preventDefault: () => prevented++,
      stopImmediatePropagation: () => undefined,
    });
    expect(prevented).toBe(0);
  });

  it("打つ面で字のキーを押したら帯を光らせる。矢印・選択・写すは光らせない", () => {
    const screen = runBlock();
    screen.take({ type: "reviewLock", locked: true, text: LOCKED_TEXT });
    refused(screen.write, "keydown", { key: "ArrowDown" });
    refused(screen.write, "keydown", { key: "c", ctrlKey: true });
    expect(screen.band.classes.has("flash")).toBe(false);
    refused(screen.write, "keydown", { key: "あ" });
    expect(screen.band.classes.has("flash")).toBe(true);
  });

  it("［連携を解除…］で拡張機能へ頼む", () => {
    const screen = runBlock();
    screen.revoke.fire("click");
    expect(screen.posted).toEqual([{ type: "revokeEditorAccess" }]);
  });

  it("届いた知らせを帯の受け口へ回している", () => {
    expect(code).toContain('message.type === "reviewLock"');
    expect(code).toMatch(/message\.type === "reviewLock"\) \{[\s\S]{0,120}takeReviewLock\(message\)/);
  });
});
