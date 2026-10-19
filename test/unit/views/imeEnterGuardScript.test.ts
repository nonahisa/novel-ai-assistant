/**
 * 変換を確定する Enter を送信として扱わない部品（`views/imeEnterGuardScript.ts`。設計書6.4.10・6.25）。
 *
 * 再現（作者の実機、2026-10-19。Windows・拡張機能開発ホスト・0.110.0）：プロットモードの
 * 相談欄に「しゅじんこうのどうき」と打って変換し、確定の Enter を1回押しただけで AI へ
 * 送られた。欄の防ぎは `isComposing || keyCode === 229` だけで、compositionend のあとに
 * isComposing=false・keyCode 13 で届く確定の keydown をすり抜けていた。
 *
 * 埋め込む JavaScript を、作り物の入力欄と時計の上で動かして確かめる（sleep しない）。
 * 欄ごとに部品を使っているかは、下の「各欄の配線」で HTML の文字列から確かめる。
 */
import { describe, expect, it } from "vitest";
import {
  IME_COMMIT_ENTER_WINDOW_MS,
  IME_ENTER_GUARD_SOURCE,
} from "../../../src/views/imeEnterGuardScript";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";
import { buildPlotModePanelHtml } from "../../../src/views/plotModePanelHtml";
import { buildWorkChatPanelHtml } from "../../../src/views/workChatPanelHtml";

interface FakeEvent {
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
}

type Listener = (event: FakeEvent) => void;

/** 作り物の入力欄。部品が張った受け口を、名前ごとに呼べるようにする */
function setup() {
  const listeners = new Map<string, Listener[]>();
  const input = {
    addEventListener(type: string, listener: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  let time = 1000;
  const run = new Function(
    "input",
    "now",
    `${IME_ENTER_GUARD_SOURCE}\nreturn watchImeEnter(input, now);`
  ) as (input: unknown, now: () => number) => (event: FakeEvent) => boolean;
  const isImeEnter = run(input, () => time);
  const fire = (type: string, event: FakeEvent = {}) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    isImeEnter,
    fire,
    advance(ms: number) {
      time += ms;
    },
  };
}

const enter: FakeEvent = { key: "Enter", keyCode: 13, isComposing: false };

describe("watchImeEnter（確定の Enter を見分ける）", () => {
  it("変換していないふつうの Enter は送る", () => {
    const { isImeEnter } = setup();
    expect(isImeEnter(enter)).toBe(false);
  });

  it("変換中（isComposing が真）の Enter は送らない", () => {
    const { isImeEnter } = setup();
    expect(isImeEnter({ key: "Enter", keyCode: 13, isComposing: true })).toBe(true);
  });

  it("keyCode 229 の Enter は送らない", () => {
    const { isImeEnter } = setup();
    expect(isImeEnter({ key: "Enter", keyCode: 229, isComposing: false })).toBe(true);
  });

  it("【再現】compositionend の直後に isComposing=false・keyCode 13 で届いた Enter は送らない", () => {
    const { isImeEnter, fire, advance } = setup();
    fire("compositionstart");
    fire("input", { isComposing: true });
    fire("compositionend");
    advance(5);
    expect(isImeEnter(enter)).toBe(true);
  });

  it("確定の Enter を離したあと（keyup）の次の Enter は送る", () => {
    const { isImeEnter, fire, advance } = setup();
    fire("compositionstart");
    fire("compositionend");
    expect(isImeEnter(enter)).toBe(true);
    fire("keyup", { key: "Enter", keyCode: 13 });
    advance(50);
    expect(isImeEnter(enter)).toBe(false);
  });

  it("keyup の来ない確定（マウスで候補を選んだ等）でも、上限を過ぎれば送る", () => {
    const { isImeEnter, fire, advance } = setup();
    fire("compositionstart");
    fire("compositionend");
    advance(IME_COMMIT_ENTER_WINDOW_MS + 1);
    expect(isImeEnter(enter)).toBe(false);
  });

  it("変換中の keyup（229）では窓を閉じない", () => {
    const { isImeEnter, fire, advance } = setup();
    fire("compositionstart");
    fire("compositionend");
    fire("keyup", { key: "Enter", keyCode: 229 });
    advance(5);
    expect(isImeEnter(enter)).toBe(true);
  });

  it("compositionstart のあと（isComposing を持たない古い環境）の Enter は送らない", () => {
    const { isImeEnter, fire } = setup();
    fire("compositionstart");
    expect(isImeEnter({ key: "Enter", keyCode: 13 })).toBe(true);
  });

  it("compositionend が落ちて印が残っても、input が変換中でないと言えば下ろして送る", () => {
    const { isImeEnter, fire } = setup();
    fire("compositionstart");
    fire("input", { isComposing: false });
    expect(isImeEnter(enter)).toBe(false);
  });

  it("焦点が外れたら印を下ろす", () => {
    const { isImeEnter, fire } = setup();
    fire("compositionstart");
    fire("blur");
    expect(isImeEnter(enter)).toBe(false);
  });

  it("埋め込む文字列はバッククォートと ${ を含まない（呼び側のテンプレートリテラルを壊さない）", () => {
    expect(IME_ENTER_GUARD_SOURCE).not.toContain("`");
    expect(IME_ENTER_GUARD_SOURCE).not.toContain("${");
  });
});

describe("各欄の配線（Enter で送る・実行する欄は同じ部品を使う）", () => {
  it("プロットモードの相談欄", () => {
    const html = buildPlotModePanelHtml("n", "c");
    expect(html).toContain("function watchImeEnter(");
    expect(html).toMatch(/watchImeEnter\(el\.adviceInput\)/);
  });

  it("作品の相談パネルの入力欄（Ctrl+Enter で送る）", () => {
    const html = buildWorkChatPanelHtml("n", "c");
    expect(html).toContain("function watchImeEnter(");
    expect(html).toMatch(/watchImeEnter\(inputEl\)/);
  });

  it("原稿エディターの探す欄（Enter で次を探す）", () => {
    const html = buildManuscriptEditorHtml("n", "c");
    expect(html).toContain("function watchImeEnter(");
    expect(html).toMatch(/watchImeEnter\(findInput\)/);
  });
});
