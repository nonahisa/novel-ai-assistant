import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { PlacedFinding } from "../../../src/core/sceneMemoRows";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 校正・メモパネルの［AIに相談］で、素のエディターを開かない（作者の報告
 * 2026-10-04。開発ホスト 0.98.9）。
 *
 * 押すと右に「テキスト エディター」で第1話が開き、画面が3列になった
 * （左に原稿エディター・真ん中に校正・メモパネル・右に素のエディター）。
 * 原因は、相談パネルへ本文を渡すために `showTextDocument`（`ViewColumn.Beside`）で
 * その行を選んだ状態で開いていたこと。原稿は原稿エディターでしか開かない
 * 決まり（設計書6.25.10・6.25.11）に反する。
 *
 * 直したあとは、素のエディターを開かずに、相談パネルへ**材料（話の題・行番号・
 * 一文と前後・指摘の中身）と相談の相手（文書と行の範囲）**を直接渡す。
 */

const { consultFindingInChat } = await import("../../../src/features/findingConsult");

const WORK: WorkEntry = {
  id: "w_consult",
  title: "氷の街",
  folderPath: "C:\\novels\\w_consult",
  registeredAt: "2026-10-04T00:00:00.000Z",
};

const FILE = "C:\\novels\\w_consult\\001.txt";

const LINES = [
  "　朝が来た。",
  "",
  "　窓の外は雪だった。",
  "　彼女は外を見ている彼女を見ていた。",
  "// TODO ここは後で",
  "　鐘が鳴った。",
];

/** 行を引ける最小の文書（本物の `TextDocument` の、ここで使う所だけ） */
function fakeDocument(): vscode.TextDocument {
  return {
    uri: vscode.Uri.file(FILE),
    lineCount: LINES.length,
    lineAt: (index: number) => ({
      text: LINES[index],
      range: { start: { line: index, character: 0 }, end: { line: index, character: LINES[index].length } },
    }),
    getText: () => LINES.join("\n"),
  } as unknown as vscode.TextDocument;
}

const FINDING = {
  id: "f1",
  time: "2026-10-04T00:00:00.000Z",
  file: "001.txt",
  hintLine: 4,
  original: "　彼女は外を見ている彼女を見ていた。",
  target: "",
  suggestion: "",
  before: "",
  after: "",
  message: "視点：ここだけ語り手が外から見ています",
  category: "proofread",
  label: "推敲",
  filePath: FILE,
  line: 4,
} as unknown as PlacedFinding;

const windowWithShow = vscode.window as unknown as {
  showTextDocument?: (...args: unknown[]) => unknown;
};

afterEach(() => {
  delete windowWithShow.showTextDocument;
});

describe("［AIに相談］は素のエディターを開かない", () => {
  test("showTextDocument を呼ばず、相談パネルへ文書と行の範囲を渡す", async () => {
    // **見張りを先に生やす。** スタブには無い関数なので、生やさずに
    // 「呼ばれない」を確かめると空振りで通ってしまう
    const show = vi.fn();
    windowWithShow.showTextDocument = show;
    const document = fakeDocument();
    const ask = vi.fn(async () => true);

    await consultFindingInChat(WORK, FINDING, {
      openDocument: async () => document,
      episodeLabelOf: async () => "第1話 雪の朝",
      askFromOutside: ask,
    });

    expect(show).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledTimes(1);
    const [, target] = ask.mock.calls[0] as unknown as [
      string,
      { document: vscode.TextDocument; range: { start: { line: number } } },
    ];
    // 相談の相手は、原稿エディターで開いているその話の文書（同じもの）
    expect(target.document).toBe(document);
    // 範囲は指摘の行（0始まりで3＝4行目）
    expect(target.range.start.line).toBe(3);
  });

  test("依頼文に、話の題・行番号・一文・前後の段落・指摘の中身が入る", async () => {
    const ask = vi.fn(async () => true);
    await consultFindingInChat(WORK, FINDING, {
      openDocument: async () => fakeDocument(),
      episodeLabelOf: async () => "第1話 雪の朝",
      askFromOutside: ask,
    });
    const question = (ask.mock.calls[0] as unknown as [string])[0];

    expect(question).toContain("第1話 雪の朝");
    expect(question).toContain("4行目");
    expect(question).toContain("【本文の一文】彼女は外を見ている彼女を見ていた。");
    // 前後は空の行とメモの行（`// TODO`）を飛ばした、本文の段落
    expect(question).toContain("【前の段落】窓の外は雪だった。");
    expect(question).toContain("【後ろの段落】鐘が鳴った。");
    expect(question).not.toContain("TODO");
    expect(question).toContain("【指摘】視点：ここだけ語り手が外から見ています");
  });

  test("話の題が引けなければ、ファイル名で場所を示す", async () => {
    const ask = vi.fn(async () => true);
    await consultFindingInChat(WORK, FINDING, {
      openDocument: async () => fakeDocument(),
      episodeLabelOf: async () => undefined,
      askFromOutside: ask,
    });
    const question = (ask.mock.calls[0] as unknown as [string])[0];
    expect(question).toContain("001.txtの4行目");
  });
});

/**
 * 原稿エディターから相談パネルへ渡す道（右クリックの「AI相談（選択範囲）」と
 * ［AIに相談］）に、素のエディターを開く呼び出しが残っていないこと。
 *
 * どちらも `extension.ts` の配線を通るので、そこを読んで見張る（単体からは
 * 拡張機能の起動を組み立てられない）。
 */
describe("相談パネルへ渡す配線（extension.ts）", () => {
  const source = readFileSync(resolve(__dirname, "../../../src/extension.ts"), "utf8");

  function body(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    expect(start, `${startMarker} が見つからない`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(endMarker, start);
    expect(end, `${endMarker} が見つからない`).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  test("原稿エディターの右クリックから相談パネルへ渡す口は、本文を開かない", () => {
    const opener = body("async function openChatWithRange(", "const sceneMemoDeps");
    expect(opener).not.toContain("showTextDocument");
    expect(opener).not.toContain("ViewColumn.Beside");
  });

  test("［AIに相談］の口は、本文を開かない", () => {
    const consult = body("consultFinding:", "applyFinding:");
    expect(consult).not.toContain("showTextDocument");
    expect(consult).not.toContain("openChatWithRange");
  });
});
