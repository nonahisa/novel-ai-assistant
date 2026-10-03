import { beforeEach, describe, expect, test, vi } from "vitest";

// 傍点を外すとき（0.96.19）に範囲を作る。スタブには Range が無いので足す
vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class Range {
    constructor(
      readonly start: unknown,
      readonly end: unknown
    ) {}
  }
  return { ...actual, Range };
});

import { window } from "../support/vscodeStub";
import { addEmphasis } from "../../../src/features/ruby";

/**
 * 傍点を付ける（設計書6.12）。
 *
 * 実機確認 A-9 の2件に当たる。
 *
 * - 範囲を選んで押すと `{{強調}}` になるか
 * - **選ばずに押したとき、選ぶよう案内されるか（勝手に拾わないか）**
 *
 * 2つ目が肝心である。**ルビは、選ばなければ直前の漢字を拾う**
 * （書いている流れの中で使うものなので、いちいち選ばせない）。
 * 傍点は拾わない——どこからどこまでを強調したいかは、漢字の切れ目とは
 * 関係が無いためである。**同じ並びのボタンで動きが違う**ので、
 * 取り違えると「押したのに何も起きない」か「思っていない範囲が強調される」。
 */

interface FakeEdit {
  range: unknown;
  text: string;
}

/**
 * 打ち込まれた編集を控える、作り物のエディタ。
 *
 * 位置は文字の番号のまま扱う（`offsetAt`／`positionAt` は素通し）。選択の
 * 範囲を渡さなければ、選んでいれば本文まるごと・選んでいなければ先頭。
 */
function editorWith(
  text: string,
  selection: { isEmpty: boolean },
  at?: { start: number; end: number }
) {
  const edits: FakeEdit[] = [];
  const range = at ?? { start: 0, end: selection.isEmpty ? 0 : text.length };
  return {
    edits,
    editor: {
      selection: { ...selection, ...range },
      document: {
        uri: {
          scheme: "file",
          fsPath: "C:/works/w/本文/001.md",
          toString: () => "file:///C:/works/w/本文/001.md",
        },
        getText: (part?: { start: number; end: number }) =>
          part ? text.slice(part.start, part.end) : text,
        offsetAt: (position: number) => position,
        positionAt: (offset: number) => offset,
      },
      edit: async (build: (builder: {
        replace: (range: unknown, next: string) => void;
      }) => void) => {
        build({
          replace: (range, next) => edits.push({ range, text: next }),
        });
        return true;
      },
    },
  };
}

let warned: string[] = [];
let informed: string[] = [];

beforeEach(() => {
  warned = [];
  informed = [];
  Object.assign(window, {
    activeTextEditor: undefined,
    showWarningMessage: vi.fn(async (text: string) => {
      warned.push(text);
      return undefined;
    }),
    showInformationMessage: vi.fn(async (text: string) => {
      informed.push(text);
      return undefined;
    }),
    createOutputChannel: () => ({
      appendLine() {},
      show() {},
      dispose() {},
    }),
  });
});

describe("傍点を付ける", () => {
  test("選んだところが `{{強調}}` になる", async () => {
    const fake = editorWith("大事", { isEmpty: false });
    Object.assign(window, { activeTextEditor: fake.editor });

    await addEmphasis();

    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0].text).toBe("{{大事}}");
  });

  test("**選ばずに押したら、案内を出して本文に触らない**", async () => {
    // ルビと違って拾わない。どこからどこまでを強調したいかは、
    // 漢字の切れ目とは関係が無い
    const fake = editorWith("", { isEmpty: true });
    Object.assign(window, { activeTextEditor: fake.editor });

    await addEmphasis();

    expect(fake.edits).toHaveLength(0);
    expect(informed.join("\n")).toContain("選んでから");
  });

  test("**行をまたいで選んだら、改行だと分かる言い方で断る**", async () => {
    // 0.51.4。記法は行をまたげない。記号のせいにしない
    const fake = editorWith("強調\n部分", { isEmpty: false });
    Object.assign(window, { activeTextEditor: fake.editor });

    await addEmphasis();

    expect(fake.edits).toHaveLength(0);
    expect(warned.join("\n")).toContain("行をまたいで");
    expect(warned.join("\n")).not.toContain("使えない記号");
  });

  test("記法の記号が混ざっていたら、記号として断る", async () => {
    const fake = editorWith("大{事", { isEmpty: false });
    Object.assign(window, { activeTextEditor: fake.editor });

    await addEmphasis();

    expect(fake.edits).toHaveLength(0);
    expect(warned.join("\n")).toContain("使えない記号");
  });

  test("`.md` でなければ断る（本文には触らない）", async () => {
    const fake = editorWith("大事", { isEmpty: false });
    fake.editor.document.uri.fsPath = "C:/works/w/設定/plot.txt";
    Object.assign(window, { activeTextEditor: fake.editor });

    await addEmphasis();

    expect(fake.edits).toHaveLength(0);
  });
});

/** 付け外しの切り替え（作者の裁定、2026-10-03。設計書6.34.2） */
describe("傍点の付いた所で押すと外す", () => {
  test("傍点の一部だけを選んでも、その傍点まるごとが字だけになる", async () => {
    // 「と」だけ（記法の内側）を選ぶ
    const fake = editorWith("あの{{とき}}は", { isEmpty: false }, { start: 4, end: 5 });
    Object.assign(window, { activeTextEditor: fake.editor });

    await addEmphasis();

    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0].text).toBe("とき");
    expect(fake.edits[0].range).toEqual({ start: 2, end: 8 });
  });

  test("`.txt` の《《強調》》も外せる（付けるのは .md だけのまま）", async () => {
    const fake = editorWith("あの《《とき》》は", { isEmpty: false }, { start: 2, end: 8 });
    fake.editor.document.uri.fsPath = "C:/works/w/本文/001.txt";
    Object.assign(window, { activeTextEditor: fake.editor });

    await addEmphasis();

    expect(fake.edits.map((edit) => edit.text)).toEqual(["とき"]);
  });

  test("傍点の無い所では、これまでどおり付ける", async () => {
    const fake = editorWith("あの{{とき}}は", { isEmpty: false }, { start: 0, end: 2 });
    Object.assign(window, { activeTextEditor: fake.editor });

    await addEmphasis();

    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0].text).toBe("{{あの}}");
  });
});
