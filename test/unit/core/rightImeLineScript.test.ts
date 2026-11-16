/**
 * 縦書きの変換中の線を行の右に出す入力欄（右傍線の入力欄）の中身（`core/rightImeLineScript.ts`。
 * 設計書6.25.2 の【裁定】2026-11-16 夜）。
 *
 * この入力欄は EditContext で日本語入力を受け、字と変換中の線をページが描く。打つ面（textarea）で
 * 日本語入力を壊した形（6.25.1 の値の入れ直し・二度目の返事の照合、6.25.2 の改行の二重と確定の遅れ）を、
 * 同じ形で踏まないことを見張る。
 *
 * 埋め込む JavaScript の文字列そのものを `new Function` で動かす（出荷しない写しを試さないため）。
 * 返事の照合（sentHistory／isOwnEcho）は、原稿エディターの台本から本物を切り出して渡す
 * ——右の入力欄が「同じ履歴を使う」ことを、本物で確かめる。
 */
import { describe, expect, it } from "vitest";
import { RIGHT_IME_LINE_SOURCE } from "../../../src/core/rightImeLineScript";
import { computeMinimalEdit } from "../../../src/core/textEdit";
import { createEditQueue } from "../../../src/core/editQueue";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

interface PaneState {
  text: string;
  selection: number;
  composing: boolean;
  formats: Array<{ start: number; end: number; style: string; thickness: string }>;
}

interface Session {
  state(): PaneState;
  textUpdate(update: { start: number; end: number; text: string; selection: number }): void;
  formatUpdate(formats: PaneState["formats"]): void;
  compositionStart(): void;
  compositionEnd(): void;
  key(kind: string): boolean;
  insert(text: string): void;
  moveCaret(to: number): void;
  incoming(text: string, undoCaret?: number): string;
  adopt(text: string): void;
  isComposing(): boolean;
}

interface Hooks {
  commit(text: string): void;
  isOwnEcho(text: string): boolean;
  forgetSent(): void;
  setEditBase(text: string): void;
  current(): string;
  defer(fn: () => void): void;
  tellContext(start: number, end: number, text: string, selection: number): void;
  render(): void;
}

interface Api {
  rlCreateSession(text: string, hooks: Hooks): Session;
  rlRenderHtml(state: PaneState): string;
  rlLineClassAt(state: PaneState, index: number): string;
  rlKeyKind(
    event: { key: string; isComposing?: boolean; keyCode?: number; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
    vertical: boolean,
    isImeEnter: (event: unknown) => boolean
  ): string | null;
  rlCaretFromPoint(
    chars: Array<{ i: number; n: number; newline: boolean; left: number; top: number; right: number; bottom: number }>,
    x: number,
    y: number,
    vertical: boolean
  ): number | undefined;
  rlRevealDelta(
    caret: { left: number; top: number; right: number; bottom: number },
    pane: { left: number; top: number; right: number; bottom: number },
    margin: number
  ): { x: number; y: number };
  rlChoosePane(setting: unknown, vertical: boolean, hasEditContext: boolean): string;
}

const api = new Function(
  RIGHT_IME_LINE_SOURCE +
    "\nreturn { rlCreateSession, rlRenderHtml, rlLineClassAt, rlKeyKind, rlCaretFromPoint, rlRevealDelta, rlChoosePane };"
)() as Api;

/** 原稿エディターの台本から、本物の返事の照合（sentHistory〜forgetSent）を切り出す */
function realEchoHistory(): {
  rememberSent(text: string): void;
  isOwnEcho(text: string): boolean;
  forgetSent(): void;
  history: string[];
} {
  const html = buildManuscriptEditorHtml("nonce", "csp");
  const code = html.slice(html.indexOf("<script"));
  const start = code.indexOf("const sentHistory = [];");
  const end = code.indexOf("/** 変換中に外から届いた本文");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return new Function(
    "let lastSent = null; const vscode = { postMessage() {} };" +
      code.slice(start, end) +
      "return { rememberSent, isOwnEcho, forgetSent, history: sentHistory };"
  )() as ReturnType<typeof realEchoHistory>;
}

/**
 * 右の入力欄を、原稿エディターの打つ面と同じつなぎ方で組む。
 * commit は打つ面の send と同じ（current と同じなら送らない・送ったら履歴に覚える）。
 * defer は「1周まわす」を手で回せるように溜めるだけにする
 */
function setup(text: string, onSend: (text: string) => void = () => undefined) {
  const echo = realEchoHistory();
  const sent: string[] = [];
  const told: Array<[number, number, string, number]> = [];
  const deferred: Array<() => void> = [];
  let current = text;
  let base: string | null = null;
  let forgot = 0;
  const hooks: Hooks = {
    commit(next) {
      if (next === current) return;
      current = next;
      echo.rememberSent(next);
      sent.push(next);
      onSend(next);
    },
    isOwnEcho: (t) => echo.isOwnEcho(t),
    forgetSent() {
      forgot += 1;
      echo.forgetSent();
    },
    setEditBase(t) {
      base = t;
    },
    current: () => current,
    defer(fn) {
      deferred.push(fn);
    },
    tellContext(s, e, t, sel) {
      told.push([s, e, t, sel]);
    },
    render() {},
  };
  const session = api.rlCreateSession(text, hooks);
  return {
    session,
    sent,
    told,
    echo,
    base: () => base,
    forgot: () => forgot,
    /** 溜めた「1周あと」を回す */
    tick() {
      const run = deferred.splice(0);
      for (const fn of run) fn();
    },
  };
}

describe("変換中に外から届いた本文（設計書6.25.1）", () => {
  it("変換中は入れ直さずに溜め、確定してから片づける", () => {
    const t = setup("朝の");
    t.session.compositionStart();
    t.session.textUpdate({ start: 2, end: 2, text: "えき", selection: 4 });
    // 変換中は送らない（確定前の字を本文へ入れると、確定のたびに二重に入る）
    expect(t.sent).toEqual([]);

    // 別の窓で頭に字が足された本文が、変換の最中に届く
    expect(t.session.incoming("夜。朝の")).toBe("held");
    // 入れ直していない：変換中の字がそのまま残り、EditContext へも何も伝えていない
    expect(t.session.state().text).toBe("朝のえき");
    expect(t.told).toEqual([]);

    t.session.textUpdate({ start: 2, end: 4, text: "駅", selection: 3 });
    t.session.compositionEnd();
    // 合図の時点ではまだ送らない（1周あと）
    expect(t.sent).toEqual([]);
    t.tick();
    // 確定した語を送り、そのあと溜めていた本文を片づける（打つ面の flushPending と同じ順）
    expect(t.sent).toEqual(["朝の駅"]);
    expect(t.session.state().text).toBe("夜。朝の");
    expect(t.session.isComposing()).toBe(false);
  });

  it("溜めた本文が自分の送った本文の返事なら、確定のあとも入れ直さない", () => {
    const t = setup("朝の");
    t.session.textUpdate({ start: 2, end: 2, text: "駅", selection: 3 });
    expect(t.sent).toEqual(["朝の駅"]);
    t.session.compositionStart();
    t.session.textUpdate({ start: 3, end: 3, text: "は", selection: 4 });
    // 語「朝の駅」の返事が、次の変換の最中に届く——溜めもしない
    expect(t.session.incoming("朝の駅")).toBe("echo");
    t.session.compositionEnd();
    t.tick();
    expect(t.session.state().text).toBe("朝の駅は");
    expect(t.sent).toEqual(["朝の駅", "朝の駅は"]);
  });
});

describe("自分が送った本文の返事（設計書6.25.1 二度目）", () => {
  it("16件の履歴で見分け、語Aの返事が語Bのあとに届いても語Bを消さない", () => {
    const t = setup("");
    t.session.textUpdate({ start: 0, end: 0, text: "語A", selection: 2 });
    t.session.textUpdate({ start: 2, end: 2, text: "語B", selection: 4 });
    expect(t.sent).toEqual(["語A", "語A語B"]);
    // 語Aの返事が遅れて届く
    expect(t.session.incoming("語A")).toBe("echo");
    expect(t.session.state().text).toBe("語A語B");
    expect(t.told).toEqual([]);
  });

  it("当たった履歴は消費する（同じ本文へ外から戻されたら、次は入れ直す）", () => {
    const t = setup("");
    t.session.textUpdate({ start: 0, end: 0, text: "語A", selection: 2 });
    t.session.textUpdate({ start: 2, end: 2, text: "語B", selection: 4 });
    expect(t.session.incoming("語A語B")).toBe("echo");
    // 返事に当たった1件とそれより古いものは忘れた
    expect(t.echo.history).toEqual([]);
    // 別の窓の取り消しで、本当に外から「語A」へ戻された
    expect(t.session.incoming("語A")).toBe("applied");
    expect(t.session.state().text).toBe("語A");
    expect(t.base()).toBe("語A");
    // EditContext にも全文の入れ替えを伝えた
    expect(t.told.at(-1)).toEqual([0, 4, "語A", 2]);
  });

  it("外からの本文を受け入れたら、履歴を空にしてから入れる", () => {
    const t = setup("");
    t.session.textUpdate({ start: 0, end: 0, text: "朝", selection: 1 });
    expect(t.session.incoming("夜")).toBe("applied");
    expect(t.forgot()).toBe(1);
    expect(t.echo.history).toEqual([]);
  });

  it("画面と同じ本文が届いたら、入れ直さず元だけ取り込む", () => {
    const t = setup("朝");
    expect(t.session.incoming("朝")).toBe("same");
    expect(t.base()).toBe("朝");
    expect(t.told).toEqual([]);
  });

  it("外から入れ直すとき、カーソルは前で一致する所より前なら動かさない", () => {
    const t = setup("あいう");
    t.session.moveCaret(1);
    t.session.incoming("あいうえお");
    expect(t.session.state().selection).toBe(1);
    t.session.moveCaret(3);
    t.session.incoming("夜あいうえお");
    // 前に1字足されたので、同じ字を指すように1つ後ろへ
    expect(t.session.state().selection).toBe(4);
  });
});

/** 好きなときに終わらせられる処理 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("改行の二重（設計書6.25.2）", () => {
  it("当てている間に次の便が来ても、改行は1つだけ入る", async () => {
    // 拡張機能の側：届いた本文を、いまの文書と見比べて変わった1か所だけ当てる（本物の順番待ちで）
    let doc = "あ";
    const gate = deferred();
    let first = true;
    const queue = createEditQueue(async (text: string) => {
      const edit = computeMinimalEdit(doc, text);
      if (first) {
        first = false;
        await gate.promise;
      }
      if (edit) doc = doc.slice(0, edit.start) + edit.insert + doc.slice(edit.end);
    });

    // 右の入力欄が送る便を、そのまま順番待ちへ流す（打つ面と同じ edit の知らせ）
    const t = setup("あ", (text) => void queue(text));

    // Enter → 当てている最中に、次の字が確定する
    expect(t.session.key("newline")).toBe(true);
    await Promise.resolve();
    t.session.textUpdate({ start: 2, end: 2, text: "い", selection: 3 });
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(t.sent).toEqual(["あ\n", "あ\nい"]);
    expect(doc).toBe("あ\nい");
  });

  it("Enter 1回で、右の入力欄の本文にも改行は1つだけ入る", () => {
    const t = setup("あ");
    t.session.key("newline");
    expect(t.session.state().text).toBe("あ\n");
    // EditContext にも同じ1か所を伝える（伝えないと、次の変換の位置がずれる）
    expect(t.told).toEqual([[1, 1, "\n", 2]]);
  });

  it("確定の Enter は改行にしない（確定の合図のあとに遅れて届く keydown も）", () => {
    const never = () => false;
    const always = () => true;
    // 変換中の Enter は IME のもの
    expect(api.rlKeyKind({ key: "Enter", isComposing: true }, true, never)).toBeNull();
    expect(api.rlKeyKind({ key: "Enter", keyCode: 229 }, true, never)).toBeNull();
    // 合図のあとに isComposing=false で届く確定の Enter（watchImeEnter が見分ける）
    expect(api.rlKeyKind({ key: "Enter", keyCode: 13, isComposing: false }, true, always)).toBeNull();
    // ふつうの Enter は改行
    expect(api.rlKeyKind({ key: "Enter", keyCode: 13, isComposing: false }, true, never)).toBe("newline");
    // Ctrl などと一緒の Enter はこの欄で受けない（本体のキー割り当てへ通す）
    expect(api.rlKeyKind({ key: "Enter", ctrlKey: true }, true, never)).toBeNull();
  });
});

describe("確定の合図のあとに来る確定ぶんの入力（設計書6.25.2）", () => {
  it("合図のあとに届いた確定の字も、1周まわしてから送る", () => {
    const t = setup("朝の");
    t.session.compositionStart();
    t.session.textUpdate({ start: 2, end: 2, text: "えき", selection: 4 });
    // Windows の日本語入力：合図（compositionend）が先に来る
    t.session.compositionEnd();
    // 確定ぶんの字が、合図のあとから届く
    t.session.textUpdate({ start: 2, end: 4, text: "駅", selection: 3 });
    t.tick();
    // 確定前の「朝のえき」は送らない。最後に届いた確定の字を送る
    expect(t.sent).not.toContain("朝のえき");
    expect(t.sent.at(-1)).toBe("朝の駅");
  });

  it("合図の時点の本文を送るのは1周あと（その間に字が来なくても送る）", () => {
    const t = setup("朝の");
    t.session.compositionStart();
    t.session.textUpdate({ start: 2, end: 2, text: "駅", selection: 3 });
    t.session.compositionEnd();
    expect(t.sent).toEqual([]);
    t.tick();
    expect(t.sent).toEqual(["朝の駅"]);
  });
});

describe("変換中の線（右に引くのは CSS。ここは線を付ける字を決める）", () => {
  it("変換中の字にだけ線のクラスを付ける", () => {
    const state: PaneState = {
      text: "朝のえき",
      selection: 4,
      composing: true,
      formats: [{ start: 2, end: 4, style: "Solid", thickness: "Thin" }],
    };
    expect(api.rlLineClassAt(state, 1)).toBe("");
    expect(api.rlLineClassAt(state, 2)).toBe("rl-comp");
    const html = api.rlRenderHtml(state);
    expect(html).toContain('<span data-i="2" data-n="1" class="rl-comp">え</span>');
    expect(html).toContain('<span data-i="0" data-n="1">朝</span>');
  });

  it("線の形（太さ・点線）と、線なしの区切りの重なり", () => {
    const state: PaneState = {
      text: "えき",
      selection: 2,
      composing: true,
      formats: [
        { start: 0, end: 2, style: "None", thickness: "None" },
        { start: 0, end: 2, style: "dotted", thickness: "thick" },
      ],
    };
    expect(api.rlLineClassAt(state, 0)).toBe("rl-comp rl-thick rl-dotted");
  });

  it("確定したら線は付かない", () => {
    const t = setup("");
    t.session.compositionStart();
    t.session.textUpdate({ start: 0, end: 0, text: "えき", selection: 2 });
    t.session.formatUpdate([{ start: 0, end: 2, style: "solid", thickness: "thin" }]);
    expect(api.rlLineClassAt(t.session.state(), 0)).toBe("rl-comp");
    t.session.compositionEnd();
    expect(api.rlLineClassAt(t.session.state(), 0)).toBe("");
  });

  it("本文の字は HTML として読まない（< と & を逃がす）", () => {
    const html = api.rlRenderHtml({ text: "<b>&", selection: 0, composing: false, formats: [] });
    expect(html).toContain("&lt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<b>");
  });

  it("サロゲートペアは1つの字として並べ、削除で半分に割らない", () => {
    const t = setup("a𠮷");
    const html = api.rlRenderHtml(t.session.state());
    expect(html).toContain('data-i="1" data-n="2"');
    t.session.key("backspace");
    expect(t.session.state().text).toBe("a");
  });
});

describe("押した点からカーソル・見える所へ送る（モバイル版に倣う）", () => {
  // 縦書き：右の列（x 100〜120）に「あい」、左の列（x 70〜90）に「う」
  const chars = [
    { i: 0, n: 1, newline: false, left: 100, right: 120, top: 0, bottom: 20 },
    { i: 1, n: 1, newline: false, left: 100, right: 120, top: 20, bottom: 40 },
    { i: 2, n: 1, newline: true, left: 100, right: 120, top: 40, bottom: 60 },
    { i: 3, n: 1, newline: false, left: 70, right: 90, top: 0, bottom: 20 },
  ];
  it("字の上半分を押せばその字の前、どの字よりも下なら列の末（改行の前）", () => {
    expect(api.rlCaretFromPoint(chars, 110, 25, true)).toBe(1);
    expect(api.rlCaretFromPoint(chars, 110, 200, true)).toBe(2);
    // 列のあいだ（字の無い所）を押しても、いちばん近い列へ
    expect(api.rlCaretFromPoint(chars, 93, 5, true)).toBe(3);
  });

  it("カーソルが欄の外なら、欄を転がす量を返す（縦書きは左右）", () => {
    const pane = { left: 0, top: 0, right: 300, bottom: 400 };
    expect(api.rlRevealDelta({ left: 100, right: 120, top: 30, bottom: 32 }, pane, 24)).toEqual({ x: 0, y: 0 });
    // 左の端の外（縦書きで読み進んだ先）
    expect(api.rlRevealDelta({ left: -50, right: -30, top: 30, bottom: 32 }, pane, 24)).toEqual({ x: -74, y: 0 });
    // 下の端の外
    expect(api.rlRevealDelta({ left: 100, right: 120, top: 390, bottom: 410 }, pane, 24)).toEqual({ x: 0, y: 34 });
  });
});

describe("どの面を使うか（既定は今までの面）", () => {
  it("右を選び、縦書きで、EditContext があるときだけ右の入力欄", () => {
    expect(api.rlChoosePane("right", true, true)).toBe("rline");
  });

  it("既定（左）・値が無い・知らない値では、いつも今までの面", () => {
    expect(api.rlChoosePane("left", true, true)).toBe("default");
    expect(api.rlChoosePane(undefined, true, true)).toBe("default");
    expect(api.rlChoosePane("RIGHT!", true, true)).toBe("default");
  });

  it("右を選んでいても、横書きでは今までの面", () => {
    expect(api.rlChoosePane("right", false, true)).toBe("default");
  });

  it("EditContext が無い環境では今までの面に戻る（理由を出す印）", () => {
    expect(api.rlChoosePane("right", true, false)).toBe("unsupported");
  });
});
