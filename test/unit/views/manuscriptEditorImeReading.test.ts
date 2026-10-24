import { afterEach, describe, expect, it, vi } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";
import {
  IME_JOIN_GAP_MS,
  readingFromComposition,
  type CompositionEvent,
} from "../../../src/core/imeReading";

/**
 * 原稿エディターでIMEの読みを拾う画面側（設計書6.42.2）。画面へ渡る本物の
 * スクリプトの `ime-reading` の印の中を切り出して動かす
 * （manuscriptEditorUnsent.test.ts と同じやり方）。
 *
 * 確かめるのは3つ——①確定のときに1回だけ知らせる、②変換中は変数を覚えるだけ
 * （入力を重くした過去がある。設計書6.34.5）、③拡張機能側の決まり
 * （`readingFromComposition`）と同じ組を送る。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

function block(): string {
  const start = code.indexOf("/* ime-reading:start */");
  const end = code.indexOf("/* ime-reading:end */");
  expect(start, "ime-reading の印が見つからない").toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

type Posted = {
  type: string;
  kana?: string;
  committed?: string;
  previous?: { kana: string; committed: string };
};

/**
 * 作り物の面の中身（書く＝textarea の値と位置、組んで書く＝選択の位置）。
 * `compose` は組んで書く面そのもの（行の段落の親。行を見分けるのに要る）
 */
interface FaceEnv {
  write?: { value: string; selectionStart: number; selectionEnd: number };
  selection?: () => unknown;
  compose?: FakeNode;
}

/**
 * 組んで書く面の作り物の DOM。画面の受け口が辿るのは nodeType・data・
 * parentNode・previousSibling・childNodes・textContent だけなので、それだけを持つ
 */
class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  constructor(
    readonly nodeType: number,
    public data = ""
  ) {}
  get previousSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    const at = siblings.indexOf(this);
    return at > 0 ? (siblings[at - 1] ?? null) : null;
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join("");
  }
  append(...children: FakeNode[]): this {
    for (const child of children) {
      child.parentNode = this;
      this.childNodes.push(child);
    }
    return this;
  }
}
const textNode = (data: string): FakeNode => new FakeNode(3, data);
const element = (...children: FakeNode[]): FakeNode => new FakeNode(1).append(...children);

/** 印の中を、作り物の2つの面の上で動かす */
function harness(env: FaceEnv = {}): {
  fire: (face: "write" | "compose", type: string, data?: string) => void;
  posted: Posted[];
} {
  const posted: Posted[] = [];
  const run = new Function(
    "posted",
    "env",
    `
    const vscode = { postMessage: (message) => posted.push(message) };
    const handlers = {};
    function face(name, base) {
      const target = base || {};
      target.addEventListener = (type, fn) => {
        (handlers[name + ":" + type] = handlers[name + ":" + type] || []).push(fn);
      };
      return target;
    }
    const write = face("write", env.write);
    const compose = face("compose", env.compose);
    const window = { getSelection: () => (env.selection ? env.selection() : null) };
    ${block()}
    return (name, type, event) => {
      for (const fn of handlers[name + ":" + type] || []) fn(event);
    };
    `
  )(posted, env) as (name: string, type: string, event: unknown) => void;
  return {
    posted,
    fire: (face, type, data) => run(face, type, data === undefined ? {} : { data }),
  };
}

/** 記録した流れを、画面の受け口へそのまま流す */
function play(face: "write" | "compose", events: CompositionEvent[]): Posted[] {
  const { fire, posted } = harness();
  for (const event of events) {
    if (event.type === "input") continue;
    fire(face, `composition${event.type}`, event.data);
  }
  return posted;
}

const FLOWS: Array<{ title: string; events: CompositionEvent[] }> = [
  {
    title: "打って変換して確定",
    events: [
      { type: "start", data: "" },
      { type: "update", data: "あ" },
      { type: "update", data: "あか" },
      { type: "update", data: "あかり" },
      { type: "update", data: "灯" },
      { type: "end", data: "灯" },
    ],
  },
  {
    title: "助詞つき",
    events: [
      { type: "start", data: "" },
      { type: "update", data: "あかりは" },
      { type: "update", data: "灯は" },
      { type: "end", data: "灯は" },
    ],
  },
  {
    title: "取り消し（Esc）",
    events: [
      { type: "start", data: "" },
      { type: "update", data: "あかり" },
      { type: "update", data: "灯" },
      { type: "end", data: "" },
    ],
  },
  {
    title: "かなのまま確定",
    events: [
      { type: "start", data: "" },
      { type: "update", data: "あかり" },
      { type: "end", data: "あかり" },
    ],
  },
  {
    title: "確定の知らせが字を持たない",
    events: [
      { type: "start", data: "" },
      { type: "update", data: "しののめ" },
      { type: "update", data: "東雲" },
      { type: "end" },
    ],
  },
];

describe("IMEの読みを拾う（画面側）", () => {
  for (const face of ["write", "compose"] as const) {
    for (const flow of FLOWS) {
      it(`${face}：${flow.title}——拡張機能側の決まりと同じ組を送る`, () => {
        const posted = play(face, flow.events);
        const expected = readingFromComposition(flow.events);
        if (!expected || expected.committed === expected.kana) {
          expect(posted).toEqual([]);
        } else {
          expect(posted).toEqual([
            { type: "imeReading", kana: expected.kana, committed: expected.committed },
          ]);
        }
      });
    }
  }

  it("変換中（update）では何も送らない。確定で1回だけ", () => {
    const { fire, posted } = harness();
    fire("compose", "compositionstart", "");
    fire("compose", "compositionupdate", "あかり");
    fire("compose", "compositionupdate", "灯");
    expect(posted).toEqual([]);
    fire("compose", "compositionend", "灯");
    fire("compose", "compositionend", "灯");
    expect(posted).toHaveLength(1);
  });

  it("前の変換のかなを次の変換へ持ち越さない", () => {
    const { fire, posted } = harness();
    fire("write", "compositionstart", "");
    fire("write", "compositionupdate", "あかり");
    // 確定の知らせが落ちた（窓の切り替えなど）まま、次の変換が始まった
    fire("write", "compositionstart", "");
    fire("write", "compositionupdate", "灯");
    fire("write", "compositionend", "灯");
    expect(posted).toEqual([]);
  });

  it("作り物の面に位置が無いときは、前の確定とつながない（取れなければつながない）", () => {
    const { fire, posted } = harness();
    for (const [kana, committed] of [["しらかば", "白樺"], ["あかり", "灯"]]) {
      fire("write", "compositionstart", "");
      fire("write", "compositionupdate", kana);
      fire("write", "compositionupdate", committed);
      fire("write", "compositionend", committed);
    }
    expect(posted.map((message) => message.previous)).toEqual([undefined, undefined]);
  });

  it("変換中の受け口は、全文を数えず・画面の要素に触らない（入力を重くしない）", () => {
    const source = block();
    const update = source.slice(
      source.indexOf("function imeReadingUpdate("),
      source.indexOf("function imeReadingEnd(")
    );
    expect(update).not.toMatch(/querySelector|textContent|innerText|\.value\b|getSelection|postMessage/);
  });
});

/**
 * 姓と名を2回に分けて確定する打ち方（作者の実機確認、2026-10-24。MS-IME）。
 * 直前の確定のすぐ後ろへ、間を置かずに続けた確定なら、前の確定も添えて送る。
 * 「続いている」はカーソルの直前の字で確かめる（位置が取れなければつながない）
 */
describe("続けて打った確定をつなげて送る（画面側）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 書く面（textarea）：確定の字を、確定の知らせの前か後に入れる */
  function textarea(initial = "") {
    const field = { value: initial, selectionStart: initial.length, selectionEnd: initial.length };
    const insert = (text: string): void => {
      const at = field.selectionEnd;
      field.value = field.value.slice(0, at) + text + field.value.slice(at);
      field.selectionStart = field.selectionEnd = at + text.length;
    };
    return { field, insert };
  }

  /** 組んで書く面（contenteditable）：面の中の1行（段落）と、その中のテキストノードとカーソル */
  function editable(initial = "") {
    const compose = new FakeNode(1);
    const node = textNode(initial);
    const line = element(node);
    compose.append(line);
    const selection = { isCollapsed: true, focusNode: node, focusOffset: initial.length };
    const insert = (text: string): void => {
      const at = selection.focusNode;
      at.data = at.data.slice(0, selection.focusOffset) + text + at.data.slice(selection.focusOffset);
      selection.focusOffset += text.length;
    };
    return { compose, line, selection, insert };
  }

  function typeOne(
    fire: (face: "write" | "compose", type: string, data?: string) => void,
    face: "write" | "compose",
    insert: (text: string) => void,
    kana: string,
    committed: string,
    order: "before-end" | "after-end" = "before-end"
  ): void {
    fire(face, "compositionstart", "");
    fire(face, "compositionupdate", kana);
    if (committed !== kana) fire(face, "compositionupdate", committed);
    // Chromium はふつう確定の知らせより先に字を入れる。Windows の日本語入力では後のことがある
    if (order === "before-end") insert(committed);
    fire(face, "compositionend", committed);
    if (order === "after-end") insert(committed);
  }

  for (const order of ["before-end", "after-end"] as const) {
    const when = order === "before-end" ? "先" : "後";
    it(`書く面：しらかば→白樺、あかり→灯 を続けて打つと、前の確定を添える（字が入るのが${when}）`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-24T21:54:19Z"));
      const { field, insert } = textarea("「");
      const { fire, posted } = harness({ write: field });
      typeOne(fire, "write", insert, "しらかば", "白樺", order);
      // 作者の actions.log の間隔（21:54:19 → :26）
      vi.setSystemTime(new Date("2026-10-24T21:54:26Z"));
      typeOne(fire, "write", insert, "あかり", "灯", order);
      expect(posted).toEqual([
        { type: "imeReading", kana: "しらかば", committed: "白樺" },
        {
          type: "imeReading",
          kana: "あかり",
          committed: "灯",
          previous: { kana: "しらかば", committed: "白樺" },
        },
      ]);
    });

    it(`組んで書く面：続けて打つと、前の確定を添える（字が入るのが${when}）`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-24T21:54:33Z"));
      const { compose, selection, insert } = editable("　");
      const { fire, posted } = harness({ compose, selection: () => selection });
      typeOne(fire, "compose", insert, "くろせ", "黒瀬", order);
      vi.setSystemTime(new Date("2026-10-24T21:54:41Z"));
      typeOne(fire, "compose", insert, "れん", "蓮", order);
      expect(posted[1]).toEqual({
        type: "imeReading",
        kana: "れん",
        committed: "蓮",
        previous: { kana: "くろせ", committed: "黒瀬" },
      });
    });
  }

  it("間が空いた2つはつながない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T21:54:19Z"));
    const { field, insert } = textarea();
    const { fire, posted } = harness({ write: field });
    typeOne(fire, "write", insert, "しらかば", "白樺");
    vi.setSystemTime(new Date(Date.now() + IME_JOIN_GAP_MS + 1));
    typeOne(fire, "write", insert, "あかり", "灯");
    expect(posted[1]).toEqual({ type: "imeReading", kana: "あかり", committed: "灯" });
  });

  it("位置が離れた2つはつながない（書く面）", () => {
    vi.useFakeTimers();
    const { field, insert } = textarea("あいうえお");
    const { fire, posted } = harness({ write: field });
    field.selectionStart = field.selectionEnd = 0;
    typeOne(fire, "write", insert, "しらかば", "白樺");
    // カーソルを末尾へ動かしてから打った
    field.selectionStart = field.selectionEnd = field.value.length;
    typeOne(fire, "write", insert, "あかり", "灯");
    expect(posted[1]).toEqual({ type: "imeReading", kana: "あかり", committed: "灯" });
  });

  it("同じ字が別の所にあっても、そこへ動いて打ったものはつながない（書く面）", () => {
    vi.useFakeTimers();
    const { field, insert } = textarea("白樺の森で。");
    const { fire, posted } = harness({ write: field });
    typeOne(fire, "write", insert, "しらかば", "白樺");
    // 本文の頭の「白樺」の直後へカーソルを動かしてから打った
    field.selectionStart = field.selectionEnd = 2;
    typeOne(fire, "write", insert, "あかり", "灯");
    expect(posted[1]).toEqual({ type: "imeReading", kana: "あかり", committed: "灯" });
  });

  it("位置が離れた2つはつながない（組んで書く面。別の行へ移った）", () => {
    vi.useFakeTimers();
    const { compose, selection, insert } = editable();
    // 2行目も、行末が前の確定と同じ字で終わっている
    const other = textNode("ほかの行の白樺");
    compose.append(element(other));
    const { fire, posted } = harness({ compose, selection: () => selection });
    typeOne(fire, "compose", insert, "しらかば", "白樺");
    selection.focusNode = other;
    selection.focusOffset = other.data.length;
    typeOne(fire, "compose", insert, "あかり", "灯");
    expect(posted[1]).toEqual({ type: "imeReading", kana: "あかり", committed: "灯" });
  });

  it("別の面で打った確定とはつながない", () => {
    vi.useFakeTimers();
    const { field, insert } = textarea();
    const { compose, selection, insert: insertCompose } = editable("白樺");
    const { fire, posted } = harness({ write: field, compose, selection: () => selection });
    typeOne(fire, "write", insert, "しらかば", "白樺");
    typeOne(fire, "compose", insertCompose, "あかり", "灯");
    expect(posted[1]).toEqual({ type: "imeReading", kana: "あかり", committed: "灯" });
  });

  it("取り消し（Esc）を挟んだらつながない", () => {
    vi.useFakeTimers();
    const { field, insert } = textarea();
    const { fire, posted } = harness({ write: field });
    typeOne(fire, "write", insert, "しらかば", "白樺");
    fire("write", "compositionstart", "");
    fire("write", "compositionupdate", "ああ");
    fire("write", "compositionend", "");
    typeOne(fire, "write", insert, "あかり", "灯");
    expect(posted[1]).toEqual({ type: "imeReading", kana: "あかり", committed: "灯" });
  });

  it("かなのまま確定した字も、前の確定に続いていれば添えて送る（それ単独では送らない）", () => {
    vi.useFakeTimers();
    const { field, insert } = textarea();
    const { fire, posted } = harness({ write: field });
    typeOne(fire, "write", insert, "あ", "あ");
    expect(posted).toEqual([]);
    typeOne(fire, "write", insert, "しらかば", "白樺");
    typeOne(fire, "write", insert, "あかり", "あかり");
    expect(posted.at(-1)).toEqual({
      type: "imeReading",
      kana: "あかり",
      committed: "あかり",
      previous: { kana: "しらかば", committed: "白樺" },
    });
  });

  it("確定の時に1回だけ送る（つないでも増えない）", () => {
    vi.useFakeTimers();
    const { field, insert } = textarea();
    const { fire, posted } = harness({ write: field });
    typeOne(fire, "write", insert, "しらかば", "白樺");
    typeOne(fire, "write", insert, "あかり", "灯");
    expect(posted).toHaveLength(2);
  });

  /*
    **作者の実機（2026-10-24 22:44、MS-IME、組んで書く面）で、つなげなかった件の再現。**
    画面の外の Chromium（CDP の IME 入力）では、確定の瞬間のカーソルは確定した字の
    直後に畳まれていて、ノードも割れずにつながった。CDP の道は「字を入れてから
    確定の知らせ」の1通りしか無いが、Windows の日本語入力（TSF）は確定の知らせの
    瞬間の選択を IME の置いた形のまま残すことがあり（確定の字の範囲が選ばれたまま、
    行の要素の上、など）、カーソルが字の直後へ動くのは知らせのあとになる。
    確定の瞬間にカーソルを読む作りでは、そのどれでも「取れない」側に倒れて、
    灯だけを拾う（作者の記録と同じ）。以下はその形を作り物の面で写したもの
  */
  describe("確定の瞬間の選択が、字の直後に畳まれていない（Windows の日本語入力の写し）", () => {
    /** 確定の知らせの間だけ、選択を別の形にしておく */
    function typeWithEndState(
      fire: (face: "write" | "compose", type: string, data?: string) => void,
      face: "write" | "compose",
      insert: (text: string) => void,
      kana: string,
      committed: string,
      during: () => () => void
    ): void {
      fire(face, "compositionstart", "");
      fire(face, "compositionupdate", kana);
      fire(face, "compositionupdate", committed);
      insert(committed);
      const restore = during();
      fire(face, "compositionend", committed);
      restore();
    }

    it("組んで書く面：確定の知らせの瞬間に、確定した字が選ばれたまま", () => {
      vi.useFakeTimers();
      const { compose, selection, insert } = editable("　ここに、名前を打って確かめてください。");
      const { fire, posted } = harness({ compose, selection: () => selection });
      const selectCommitted = (): (() => void) => {
        selection.isCollapsed = false;
        return () => {
          selection.isCollapsed = true;
        };
      };
      typeWithEndState(fire, "compose", insert, "しらかば", "白樺", selectCommitted);
      typeWithEndState(fire, "compose", insert, "あかり", "灯", selectCommitted);
      expect(posted[1]).toEqual({
        type: "imeReading",
        kana: "あかり",
        committed: "灯",
        previous: { kana: "しらかば", committed: "白樺" },
      });
    });

    it("組んで書く面：確定の知らせの瞬間に、カーソルが行の要素の上にある", () => {
      vi.useFakeTimers();
      const { compose, line, selection, insert } = editable("");
      const { fire, posted } = harness({ compose, selection: () => selection });
      const onLine = (): (() => void) => {
        const node = selection.focusNode;
        const offset = selection.focusOffset;
        selection.focusNode = line;
        selection.focusOffset = line.childNodes.length;
        return () => {
          selection.focusNode = node;
          selection.focusOffset = offset;
        };
      };
      typeWithEndState(fire, "compose", insert, "くろせ", "黒瀬", onLine);
      typeWithEndState(fire, "compose", insert, "れん", "蓮", onLine);
      expect(posted[1]).toEqual({
        type: "imeReading",
        kana: "れん",
        committed: "蓮",
        previous: { kana: "くろせ", committed: "黒瀬" },
      });
    });

    it("組んで書く面：次の変換が、前の確定とは別のテキストノードへ入る", () => {
      vi.useFakeTimers();
      const { compose, line, selection, insert } = editable("");
      const { fire, posted } = harness({ compose, selection: () => selection });
      typeOne(fire, "compose", insert, "しらかば", "白樺");
      // 前の確定の後ろ（行の要素の上）から次の変換を始め、新しいノードに字が入った
      selection.focusNode = line;
      selection.focusOffset = line.childNodes.length;
      fire("compose", "compositionstart", "");
      const fresh = textNode("");
      line.append(fresh);
      selection.focusNode = fresh;
      selection.focusOffset = 0;
      fire("compose", "compositionupdate", "あかり");
      fire("compose", "compositionupdate", "灯");
      insert("灯");
      fire("compose", "compositionend", "灯");
      expect(posted[1]).toEqual({
        type: "imeReading",
        kana: "あかり",
        committed: "灯",
        previous: { kana: "しらかば", committed: "白樺" },
      });
    });

    it("書く面：確定の知らせの瞬間に、確定した字が選ばれたまま", () => {
      vi.useFakeTimers();
      const { field, insert } = textarea("　");
      const { fire, posted } = harness({ write: field });
      const selectCommitted = (length: number) => (): (() => void) => {
        const end = field.selectionEnd;
        field.selectionStart = end - length;
        return () => {
          field.selectionStart = end;
        };
      };
      typeWithEndState(fire, "write", insert, "しらかば", "白樺", selectCommitted(2));
      typeWithEndState(fire, "write", insert, "あかり", "灯", selectCommitted(1));
      expect(posted[1]).toEqual({
        type: "imeReading",
        kana: "あかり",
        committed: "灯",
        previous: { kana: "しらかば", committed: "白樺" },
      });
    });

    it("組んで書く面：前の確定と次の変換の間に、色付けの要素などで分かれた字があってもよい", () => {
      vi.useFakeTimers();
      // 行：「…」（三点リーダの印）＋「白樺」。カーソルは行の要素の末尾
      const tail = textNode("白樺");
      const compose = new FakeNode(1);
      const line = element(textNode("「"), element(textNode("…")), tail);
      compose.append(line);
      const selection = { isCollapsed: true, focusNode: tail, focusOffset: 2 };
      const { fire, posted } = harness({ compose, selection: () => selection });
      // 前の確定を覚えさせる（字はもう入っている体）
      fire("compose", "compositionstart", "");
      selection.focusNode = line;
      selection.focusOffset = 2;
      fire("compose", "compositionupdate", "しらかば");
      fire("compose", "compositionupdate", "白樺");
      fire("compose", "compositionend", "白樺");
      selection.focusNode = line;
      selection.focusOffset = 3;
      fire("compose", "compositionstart", "");
      fire("compose", "compositionupdate", "あかり");
      fire("compose", "compositionupdate", "灯");
      fire("compose", "compositionend", "灯");
      expect(posted[1]?.previous).toEqual({ kana: "しらかば", committed: "白樺" });
    });
  });

  it("続いているかは変換の始まりで読み、確定の瞬間にはカーソルを読まない", () => {
    const source = block();
    const start = source.slice(
      source.indexOf("function imeReadingStart("),
      source.indexOf("function imeReadingUpdate(")
    );
    expect(start).toContain("imeCaretContext(face)");
    const end = source.slice(source.indexOf("function imeReadingEnd("));
    expect(end).not.toMatch(/getSelection|selectionStart|selectionEnd|imeCaretContext/);
  });

  it("つなげる間の長さは、拡張機能側の定数と同じ", () => {
    expect(block()).toContain(`IME_JOIN_GAP_MS = ${IME_JOIN_GAP_MS}`);
  });
});
