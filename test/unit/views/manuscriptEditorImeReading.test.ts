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

/** 作り物の面の中身（書く＝textarea の値と位置、組んで書く＝選択の位置） */
interface FaceEnv {
  write?: { value: string; selectionStart: number; selectionEnd: number };
  selection?: () => unknown;
}

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
    const compose = face("compose");
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

  /** 組んで書く面（contenteditable）：1つのテキストノードとカーソル */
  function editable(initial = "") {
    const node = { nodeType: 3, data: initial };
    const selection = { isCollapsed: true, focusNode: node as unknown, focusOffset: initial.length };
    const insert = (text: string): void => {
      node.data =
        node.data.slice(0, selection.focusOffset) + text + node.data.slice(selection.focusOffset);
      selection.focusOffset += text.length;
    };
    return { selection, insert };
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
      const { selection, insert } = editable("　");
      const { fire, posted } = harness({ selection: () => selection });
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

  it("位置が離れた2つはつながない（組んで書く面。別のノードへ移った）", () => {
    vi.useFakeTimers();
    const first = editable();
    const second = editable("ほかの行");
    let current = first.selection;
    const { fire, posted } = harness({ selection: () => current });
    typeOne(fire, "compose", first.insert, "しらかば", "白樺");
    current = second.selection;
    typeOne(fire, "compose", second.insert, "あかり", "灯");
    expect(posted[1]).toEqual({ type: "imeReading", kana: "あかり", committed: "灯" });
  });

  it("別の面で打った確定とはつながない", () => {
    vi.useFakeTimers();
    const { field, insert } = textarea();
    const { selection, insert: insertCompose } = editable("白樺");
    const { fire, posted } = harness({ write: field, selection: () => selection });
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

  it("つなげる間の長さは、拡張機能側の定数と同じ", () => {
    expect(block()).toContain(`IME_JOIN_GAP_MS = ${IME_JOIN_GAP_MS}`);
  });
});
