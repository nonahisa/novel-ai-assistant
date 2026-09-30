import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 見た目を切り替えても、見ていた場所を保つ（作者の依頼、2026-10-01）。
 *
 * 縦書き⇔横書きのボタンを押すと paint() で組み直され、スクロールが先頭へ
 * 戻っていた。長い話の途中で向きを変えると、書いていた場所を探し直すことに
 * なる。字の大きさ・note風・書体も、組み直しで見えている場所がずれる。
 *
 * ここでは、画面へ渡る本物のスクリプトから「控える → 戻す」の部分
 * （view-anchor の印の間）を切り出し、**採寸だけを偽物に差し替えて**
 * 振る舞いを確かめる（manuscriptEditorUnsent.test.ts と同じやり方）。
 * 採寸そのもの（写しの面を作って字の箱を測る）は画面でしか確かめられない
 * ので、実機確認に回す。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

function markedBlock(name: string): string {
  const start = code.indexOf(`/* ${name}:start */`);
  const end = code.indexOf(`/* ${name}:end */`);
  expect(start, `${name} の印が見つからない`).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

/** `function name(` から、字下げ2つの閉じ括弧までを切り出す */
function functionSource(name: string): string {
  const start = code.indexOf(`  function ${name}(`);
  expect(start, `${name} が見つからない`).toBeGreaterThan(0);
  const close = "\n  }\n";
  const end = code.indexOf(close, start);
  return code.slice(start, end + close.length);
}

/** `owner.addEventListener("type", function (...) {...});` をまるごと切り出す */
function listenerSource(owner: string, type: string): string {
  const head = `  ${owner}.addEventListener("${type}", function (`;
  const start = code.indexOf(head);
  expect(start, `${owner} の ${type} の受け口が見つからない`).toBeGreaterThan(0);
  const close = "\n  });";
  const end = code.indexOf(close, start);
  return code.slice(start, end + close.length);
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * 偽の組版。1行10字、行の幅（高さ）20px、見える枠は 100×100、余白24px。
 *
 * - 横書き：行は上から下へ。scrollTop を増やすと中身が上へ動く
 * - 縦書き：行は右から左へ（vertical-rl）。scrollLeft は 0 が始まりで、
 *   左へ進むほど負になる（Chromium と同じ数え方）
 */
interface FakeFace {
  name: "write" | "compose";
  vertical: boolean;
  scrollLeft: number;
  scrollTop: number;
  shown: boolean;
  focusCalls: number;
}

const BOX: Rect = { left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 };

function rectOf(face: FakeFace, offset: number): Rect {
  const line = Math.floor(offset / 10);
  const column = offset % 10;
  if (face.vertical) {
    const right = 76 - line * 20 - face.scrollLeft;
    const top = 10 + column * 8;
    return { left: right - 20, right, top, bottom: top + 8, width: 20, height: 8 };
  }
  const top = 24 + line * 20 - face.scrollTop;
  const left = 10 + column * 8;
  return { left, right: left + 8, top, bottom: top + 20, width: 8, height: 20 };
}

function inside(rect: Rect): boolean {
  return (
    rect.left >= BOX.left && rect.right <= BOX.right && rect.top >= BOX.top && rect.bottom <= BOX.bottom
  );
}

interface Harness {
  write: FakeFace;
  compose: FakeFace;
  setComposeOn(value: boolean): void;
  setActive(face: "write" | "compose" | "button"): void;
  setSelection(selection: { start: number; end: number } | null): void;
  hold(): Anchor | null;
  restore(anchor: Anchor | null): void;
  runFrames(): void;
  restoredSelections(): Array<{ start: number; end: number }>;
  searchFirst(length: number, test: (at: number) => boolean): number;
}

interface Anchor {
  face: string;
  offset: number;
  kind: string;
  selection: { start: number; end: number } | null;
  focus: boolean;
}

function harness(options: { length?: number } = {}): Harness {
  const block = markedBlock("view-anchor");
  const offRect = functionSource("offRect");
  const face = (name: "write" | "compose"): FakeFace => ({
    name,
    vertical: false,
    scrollLeft: 0,
    scrollTop: 0,
    shown: true,
    focusCalls: 0,
  });
  const env = {
    write: face("write"),
    compose: face("compose"),
    composeOn: false,
    active: "write" as string,
    selection: null as { start: number; end: number } | null,
    restored: [] as Array<{ start: number; end: number }>,
    frames: [] as Array<() => void>,
    length: options.length ?? 1000,
    rectOf,
    box: BOX,
  };
  const elements = {
    write: {
      focus: () => (env.write.focusCalls += 1),
      get selectionStart() {
        return env.selection ? env.selection.start : 0;
      },
      get selectionEnd() {
        return env.selection ? env.selection.end : 0;
      },
      setSelectionRange: (start: number, end: number) => env.restored.push({ start, end }),
    },
    compose: {
      focus: () => (env.compose.focusCalls += 1),
    },
    button: {},
  };
  const run = new Function(
    "env",
    "elements",
    `
    // 画面のスクリプトでは let。組んで書く面にいるか
    let composeOn = false;
    const write = elements.write;
    const compose = elements.compose;
    const button = { addEventListener() {} };
    const dirButton = button;
    const noteStyleButton = button;
    const notePvButton = button;
    const document = {
      get activeElement() { return elements[env.active]; },
      getElementById: () => button,
    };
    function composeSelectionNow() { return env.selection; }
    function composeRestoreCaret(at) { if (at) env.restored.push({ start: at.start, end: at.end }); }
    function requestAnimationFrame(fn) { env.frames.push(fn); return env.frames.length; }
    // 偽の採寸。本物は写しの面（打つ面）か範囲（組んで書く面）で字の箱を測る
    function viewMeasure(element) {
      const state = element === compose ? env.compose : env.write;
      if (!state.shown) return null;
      return {
        vertical: state.vertical,
        length: env.length,
        container: { getBoundingClientRect: () => env.box },
        rectAt: (at) => env.rectOf(state, Math.max(0, Math.min(at, env.length - 1))),
        scrollBy: (left, top) => { state.scrollLeft += left; state.scrollTop += top; },
        done() {},
      };
    }
    ${offRect}
    ${block}
    return {
      setComposeOn: (value) => { composeOn = value; },
      hold: () => viewHold(),
      restore: (anchor) => viewRestore(anchor),
      searchFirst: (length, test) => viewSearchFirst(length, test),
    };
    `
  )(env, elements) as {
    setComposeOn(value: boolean): void;
    hold(): Anchor | null;
    restore(anchor: Anchor | null): void;
    searchFirst(length: number, test: (at: number) => boolean): number;
  };
  return {
    write: env.write,
    compose: env.compose,
    setComposeOn: (value) => {
      env.composeOn = value;
      run.setComposeOn(value);
    },
    setActive: (name) => (env.active = name),
    setSelection: (selection) => (env.selection = selection),
    hold: () => run.hold(),
    restore: (anchor) => run.restore(anchor),
    runFrames: () => {
      for (const frame of env.frames.splice(0)) frame();
    },
    restoredSelections: () => env.restored,
    searchFirst: (length, test) => run.searchFirst(length, test),
  };
}

/** 横書き→縦書きへ切り替えたときの paint() の代わり。**向きが変わるとスクロールは初めへ戻る** */
function turnVertical(face: FakeFace): void {
  face.vertical = true;
  face.scrollLeft = 0;
  face.scrollTop = 0;
}

describe("見ていた場所を字で控える", () => {
  it("カーソルが見えていれば、カーソルの字を控える", () => {
    const h = harness();
    h.write.scrollTop = 1000; // 50行目あたりを見ている
    h.setSelection({ start: 505, end: 505 });
    const anchor = h.hold();
    expect(anchor).toMatchObject({ face: "write", offset: 505, kind: "caret", focus: true });
    expect(anchor?.selection).toEqual({ start: 505, end: 505 });
  });

  it("**カーソルが画面の外なら、画面の先頭に見えている字を控える**（カーソルは別に覚えておく）", () => {
    const h = harness();
    h.write.scrollTop = 1000;
    h.setSelection({ start: 5, end: 5 });
    const anchor = h.hold();
    // 48行目は上の縁で半分切れている。**まるごと見えている最初の行**（49行目）を控える
    expect(anchor).toMatchObject({ offset: 490, kind: "top" });
    expect(anchor?.selection).toEqual({ start: 5, end: 5 });
  });

  it("縦書きでも、画面の先頭（右端）に見えている字を控える", () => {
    const h = harness();
    h.write.vertical = true;
    h.write.scrollLeft = -600; // 30行ぶん左へ進んでいる
    h.setSelection(null);
    const anchor = h.hold();
    const rect = rectOf(h.write, anchor!.offset);
    // 控えた字の行はまるごと見えていて、その1行前は右へはみ出している
    expect(rect.right).toBeLessThanOrEqual(BOX.right);
    expect(rectOf(h.write, anchor!.offset - 10).right).toBeGreaterThan(BOX.right);
  });

  it("面が隠れていて測れないときは、控えない（戻すときも何もしない）", () => {
    const h = harness();
    h.write.shown = false;
    expect(h.hold()).toBeNull();
    h.restore(null);
    expect(h.write.focusCalls).toBe(0);
  });

  it("焦点が本文に無かった（ボタンやキーボードで押した）なら、焦点は取らない", () => {
    const h = harness();
    h.setActive("button");
    h.setSelection({ start: 0, end: 0 });
    const anchor = h.hold();
    expect(anchor?.focus).toBe(false);
    h.restore(anchor);
    expect(h.write.focusCalls).toBe(0);
  });

  it("二分探索は「満たす最初の位置」を返す（無ければ末尾）", () => {
    const h = harness();
    expect(h.searchFirst(100, (at) => at >= 37)).toBe(37);
    expect(h.searchFirst(100, () => true)).toBe(0);
    expect(h.searchFirst(100, () => false)).toBe(100);
    expect(h.searchFirst(0, () => true)).toBe(0);
  });
});

describe("組み直したあとに、控えた字の見える所へ戻す", () => {
  for (const faceName of ["write", "compose"] as const) {
    it(`${faceName}：**横書き→縦書きで、カーソルの字が見える所へ動き、焦点と選択も戻る**`, () => {
      const h = harness();
      h.setComposeOn(faceName === "compose");
      h.setActive(faceName);
      const face = h[faceName];
      face.scrollTop = 1000;
      h.setSelection({ start: 505, end: 507 });
      const anchor = h.hold();
      expect(anchor?.kind).toBe("caret");

      turnVertical(face);
      expect(inside(rectOf(face, 505)), "組み直した直後は先頭へ戻っている").toBe(false);
      h.restore(anchor);
      expect(inside(rectOf(face, 505)), "カーソルの字が見えていない").toBe(true);
      expect(face.focusCalls).toBe(1);
      expect(h.restoredSelections()).toEqual([{ start: 505, end: 507 }]);
    });

    it(`${faceName}：カーソルが外にあったときは、見ていた先頭の字を画面の先頭側へ置く`, () => {
      const h = harness();
      h.setComposeOn(faceName === "compose");
      const face = h[faceName];
      face.scrollTop = 1000;
      h.setSelection({ start: 5, end: 5 });
      const anchor = h.hold();
      expect(anchor?.kind).toBe("top");

      turnVertical(face);
      h.restore(anchor);
      const rect = rectOf(face, anchor!.offset);
      expect(inside(rect)).toBe(true);
      // 縦書きの先頭は右。右端のすぐ内側に来る（見ていた続きが左へ並ぶ）
      expect(rect.right).toBe(BOX.right - 8);
      // **もう一度控えても同じ字になる**（押すたびに前へずれない）
      expect(h.hold()?.offset).toBe(anchor!.offset);
      // カーソルそのものは元の場所へ戻す（画面は動かさない）
      expect(h.restoredSelections()).toEqual([{ start: 5, end: 5 }]);
    });
  }

  it("1拍あとにもう一度合わせる（すでに見えていれば動かさない）", () => {
    const h = harness();
    h.write.scrollTop = 1000;
    h.setSelection({ start: 505, end: 505 });
    const anchor = h.hold();
    turnVertical(h.write);
    h.restore(anchor);
    const settled = h.write.scrollLeft;
    h.runFrames();
    expect(h.write.scrollLeft).toBe(settled);
  });

  it("面が入れ替わっていたら（打つ面⇔組んで書く面）、何もしない", () => {
    const h = harness();
    h.write.scrollTop = 1000;
    h.setSelection({ start: 505, end: 505 });
    const anchor = h.hold();
    h.setComposeOn(true);
    h.restore(anchor);
    expect(h.compose.focusCalls).toBe(0);
    expect(h.restoredSelections()).toEqual([]);
  });
});

describe("切り替えのボタンが、控えと戻しを通る", () => {
  it("縦書き⇔横書き：控えてから向きを変え、組み直したあとに戻す", () => {
    const listener = listenerSource("dirButton", "click");
    const hold = listener.indexOf("viewTakePress()");
    const flip = listener.indexOf("vertical = vertical === false");
    const paint = listener.indexOf("paint()");
    const restore = listener.indexOf("viewRestore(");
    expect(hold, "押す前の場所を控えていない").toBeGreaterThan(0);
    expect(hold).toBeLessThan(flip);
    expect(paint).toBeLessThan(restore);
  });

  it("字の大きさ・note風・貼り付け後も同じ仕組みに乗る", () => {
    for (const [owner, id] of [
      ["document.getElementById(\"bigger\")", "bigger"],
      ["document.getElementById(\"smaller\")", "smaller"],
      ["noteStyleButton", "noteStyle"],
      ["notePvButton", "notePv"],
    ] as const) {
      const listener = listenerSource(owner, "click");
      expect(listener, `${id} が控えていない`).toContain("viewTakePress()");
      expect(listener, `${id} が戻していない`).toContain("viewRestore(");
    }
  });

  it("押した瞬間（mousedown）に控える——押したあとは焦点がボタンへ移り、組んで書く面では選択も外れる", () => {
    const block = markedBlock("view-anchor");
    for (const name of ["dirButton", "noteStyleButton", "notePvButton", '"bigger"', '"smaller"', '"font"']) {
      expect(block, `${name} の mousedown で控えていない`).toContain(name);
    }
    expect(block).toContain('"mousedown"');
  });

  it("書体が変わったときも、変える前の場所へ戻す", () => {
    const start = code.indexOf("if (message.fontFamily)");
    const part = code.slice(start, code.indexOf("markFontFamily", start));
    expect(part).toContain("viewRestore(");
  });
});
