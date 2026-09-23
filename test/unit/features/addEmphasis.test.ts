import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "./support/vscodeStub";
import { addEmphasis } from "../../src/features/ruby";

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

/** 打ち込まれた編集を控える、作り物のエディタ */
function editorWith(text: string, selection: { isEmpty: boolean }) {
  const edits: FakeEdit[] = [];
  return {
    edits,
    editor: {
      selection,
      document: {
        uri: {
          scheme: "file",
          fsPath: "C:/works/w/本文/001.md",
          toString: () => "file:///C:/works/w/本文/001.md",
        },
        getText: () => text,
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
