import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";
import {
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

type Posted = { type: string; kana?: string; committed?: string };

/** 印の中を、作り物の2つの面の上で動かす */
function harness(): {
  fire: (face: "write" | "compose", type: string, data?: string) => void;
  posted: Posted[];
} {
  const posted: Posted[] = [];
  const run = new Function(
    "posted",
    `
    const vscode = { postMessage: (message) => posted.push(message) };
    const handlers = {};
    function face(name) {
      return {
        addEventListener: (type, fn) => {
          (handlers[name + ":" + type] = handlers[name + ":" + type] || []).push(fn);
        },
      };
    }
    const write = face("write");
    const compose = face("compose");
    ${block()}
    return (name, type, event) => {
      for (const fn of handlers[name + ":" + type] || []) fn(event);
    };
    `
  )(posted) as (name: string, type: string, event: unknown) => void;
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

  it("変換中の受け口は、全文を数えず・画面の要素に触らない（入力を重くしない）", () => {
    const source = block();
    const update = source.slice(
      source.indexOf("function imeReadingUpdate("),
      source.indexOf("function imeReadingEnd(")
    );
    expect(update).not.toMatch(/querySelector|textContent|innerText|\.value\b|getSelection|postMessage/);
  });
});
