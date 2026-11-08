import { describe, expect, it, vi } from "vitest";
import iconv = require("iconv-lite");
import * as vscode from "vscode";
import {
  createUnencodableWarner,
  handleWillSave,
  type ShiftJisSaveDeps,
  type UnencodableSave,
} from "../../../src/features/shiftJisSave";

/**
 * 作者が VS Code で打って保存する道の、Shift_JIS の字の置き換え（設計書5.4.2、0.148.1）。
 *
 * **再現したいこと**：0.148.0 の置き換えは拡張機能が書き戻す道（`writeTextFilePreservingFormat`）
 * だけに効き、作者が素のエディター・原稿エディターで打って保存すると、VS Code 自身が
 * Shift_JIS で書いて「〜」「♡」を黙って「?」（0x3f）にする。保存の直前の受け口
 * （`onWillSaveTextDocument` の `waitUntil`）で、表の字を字ごとに置き換える。
 */

const WORK = "C:\\小説\\作品";
const EPISODE = `${WORK}\\本文\\001.txt`;

interface FakeDocumentInit {
  text: string;
  /** VS Code 1.90 には無い欄。省くと 1.90 の道（先頭のバイトで決める）を通る */
  encoding?: string;
  filePath?: string;
}

function fakeDocument(init: FakeDocumentInit): vscode.TextDocument {
  const text = init.text;
  const document = {
    uri: vscode.Uri.file(init.filePath ?? EPISODE),
    getText: () => text,
    positionAt: (offset: number) => {
      const before = text.slice(0, offset);
      const lines = before.split("\n");
      return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
    },
    ...(init.encoding === undefined ? {} : { encoding: init.encoding }),
  };
  return document as unknown as vscode.TextDocument;
}

interface Harness {
  deps: ShiftJisSaveDeps;
  logs: string[];
  unencodable: UnencodableSave[];
  clean: string[];
}

function harness(overrides: Partial<ShiftJisSaveDeps> = {}): Harness {
  const logs: string[] = [];
  const unencodable: UnencodableSave[] = [];
  const clean: string[] = [];
  const deps: ShiftJisSaveDeps = {
    // 作り物の Uri.file はドライブ名を小文字にするので、大文字小文字を無視して比べる
    workFolderOf: (filePath) =>
      filePath.toLowerCase().startsWith(`${WORK}\\本文\\`.toLowerCase()) ? WORK : undefined,
    readBytes: async () => {
      throw new Error("この件ではファイルを読まない");
    },
    configuredEncoding: () => undefined,
    log: (_work, message) => logs.push(message),
    onUnencodable: (report) => unencodable.push(report),
    onClean: (document) => clean.push(document.uri.toString()),
    ...overrides,
  };
  return { deps, logs, unencodable, clean };
}

/** 受け口を鳴らし、`waitUntil` に渡された書き換えを返す（呼ばれなければ undefined） */
async function fire(document: vscode.TextDocument, deps: ShiftJisSaveDeps): Promise<vscode.TextEdit[] | undefined> {
  let waited: Thenable<readonly vscode.TextEdit[]> | undefined;
  handleWillSave(
    {
      document,
      waitUntil: (thenable: Thenable<readonly vscode.TextEdit[]>) => {
        waited = thenable;
      },
    },
    deps
  );
  return waited ? [...(await waited)] : undefined;
}

function rangeOf(edit: vscode.TextEdit): string {
  const { start, end } = edit.range;
  return `${start.line}:${start.character}-${end.line}:${end.character}`;
}

describe("保存の直前の Shift_JIS の置き換え（onWillSaveTextDocument）", () => {
  it("Shift_JIS の話では、表の字を字ごとの書き換えで返し、ログに何を何に何個かを残す", async () => {
    const h = harness();
    const edits = await fire(fakeDocument({ text: "あ〜い〜\n𠮟る", encoding: "shiftjis" }), h.deps);
    expect(edits?.map((edit) => [rangeOf(edit), edit.newText])).toEqual([
      ["0:1-0:2", "～"],
      ["0:3-0:4", "～"],
      // 𠮟 はサロゲートの2単位。範囲は元の字の長さで取る
      ["1:0-1:2", "叱"],
    ]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("001.txt");
    expect(h.logs[0]).toContain("〜→～ 2個、𠮟→叱 1個");
    expect(h.unencodable).toEqual([]);
  });

  it("UTF-8 の話では、保存を待たせず何もしない", async () => {
    const h = harness();
    const edits = await fire(fakeDocument({ text: "あ〜い♡", encoding: "utf8" }), h.deps);
    expect(edits).toBeUndefined();
    expect(h.logs).toEqual([]);
    expect(h.unencodable).toEqual([]);
  });

  it("作品の外のファイルは、Shift_JIS でも触らない", async () => {
    const h = harness();
    const edits = await fire(
      fakeDocument({ text: "あ〜", encoding: "shiftjis", filePath: "C:\\よそ\\メモ.txt" }),
      h.deps
    );
    expect(edits).toBeUndefined();
  });

  it("CRLF の話でも、行と桁は文書の位置で取る（改行を LF に揃えて数えない）", async () => {
    const h = harness();
    const edits = await fire(fakeDocument({ text: "一行目\r\n二〜行目", encoding: "shiftjis" }), h.deps);
    expect(edits?.map(rangeOf)).toEqual(["1:1-1:2"]);
  });

  it("置き換え先の無い字（♡）が残るときは、表の字は置き換え、♡ は場所つきで知らせの係へ渡す", async () => {
    const h = harness();
    const text = "あ〜\nかきくけ♡さしすせ";
    const edits = await fire(fakeDocument({ text, encoding: "shiftjis" }), h.deps);
    expect(edits?.map((edit) => edit.newText)).toEqual(["～"]);
    expect(h.unencodable).toHaveLength(1);
    const [report] = h.unencodable;
    expect(report.workFolder).toBe(WORK);
    // 控えに残すのは、作者が打ったままの本文（置き換える前）
    expect(report.text).toBe(text);
    expect(report.found).toEqual([{ char: "♡", line: 2, context: "かきくけ♡さしすせ" }]);
    // ログに本文の前後は書かない（字と行だけ）
    expect(h.logs.join("\n")).not.toContain("かきくけ");
    expect(h.logs.join("\n")).toContain("♡");
    expect(h.clean).toEqual([]);
  });

  it("書けない字が無くなった保存では、知らせの係に「もう無い」と伝える", async () => {
    const h = harness();
    await fire(fakeDocument({ text: "あ〜い", encoding: "shiftjis" }), h.deps);
    expect(h.clean).toHaveLength(1);
  });

  describe("VS Code 1.90（文書に文字コードの欄が無い）", () => {
    it("ファイルの先頭のバイトが Shift_JIS なら置き換える", async () => {
      const h = harness({ readBytes: async () => iconv.encode("既にある本文。", "shift_jis") });
      const edits = await fire(fakeDocument({ text: "既にある本文。〜" }), h.deps);
      expect(edits?.map((edit) => edit.newText)).toEqual(["～"]);
    });

    it("ファイルが UTF-8 なら何もしない", async () => {
      const h = harness({ readBytes: async () => new TextEncoder().encode("既にある本文。") });
      const edits = await fire(fakeDocument({ text: "既にある本文。〜" }), h.deps);
      expect(edits).toEqual([]);
    });

    it("バイトが英数字だけで決まらないときは、設定 files.encoding に従う", async () => {
      const ascii = new TextEncoder().encode("abc");
      const sjis = harness({ readBytes: async () => ascii, configuredEncoding: () => "shiftjis" });
      expect((await fire(fakeDocument({ text: "abc〜" }), sjis.deps))?.map((edit) => edit.newText)).toEqual(["～"]);
      const utf8 = harness({ readBytes: async () => ascii, configuredEncoding: () => "utf8" });
      expect(await fire(fakeDocument({ text: "abc〜" }), utf8.deps)).toEqual([]);
    });

    it("まだディスクに無い（読めない）話は、設定 files.encoding に従う", async () => {
      const missing = async (): Promise<Uint8Array> => {
        throw new Error("FileNotFound");
      };
      const sjis = harness({ readBytes: missing, configuredEncoding: () => "shiftjis" });
      expect((await fire(fakeDocument({ text: "〜" }), sjis.deps))?.map((edit) => edit.newText)).toEqual(["～"]);
      const unset = harness({ readBytes: missing });
      expect(await fire(fakeDocument({ text: "〜" }), unset.deps)).toEqual([]);
    });

    it("途中で失敗しても保存を止めない（書き換え無しで返し、ログに残す）", async () => {
      const h = harness({
        readBytes: async () => new TextEncoder().encode("abc"),
        configuredEncoding: () => {
          throw new Error("設定を読めない");
        },
      });
      const edits = await fire(fakeDocument({ text: "〜" }), h.deps);
      expect(edits).toEqual([]);
      expect(h.logs.join("\n")).toContain("設定を読めない");
    });
  });
});

describe("置き換え先の無い字の知らせ（保存は止められないので、控えを取って知らせる）", () => {
  function report(text: string, chars: string[]): UnencodableSave {
    const document = fakeDocument({ text, encoding: "shiftjis" });
    return {
      document,
      filePath: EPISODE,
      workFolder: WORK,
      text,
      found: chars.map((char, index) => ({ char, line: index + 1, context: char })),
    };
  }

  it("控えを取ってから、保存が済んだあとに真ん中の窓で知らせる。同じ字の組では2度出さない", async () => {
    const kept: string[] = [];
    const warned: Array<{ message: string; detail: string }> = [];
    let saved: () => void = () => undefined;
    const warner = createUnencodableWarner({
      keep: async (_filePath, text) => {
        kept.push(text);
        return `${WORK}\\.novelai-recovery\\控え.bak`;
      },
      whenSaved: () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
      warn: async (message, detail) => {
        warned.push({ message, detail });
        return undefined;
      },
      openKeep: () => undefined,
      log: () => undefined,
    });

    warner.report(report("かきくけ♡", ["♡"]));
    await vi.waitFor(() => expect(kept).toEqual(["かきくけ♡"]));
    // 保存が済むまでは知らせない（「? になりました」を先に言わない）
    expect(warned).toEqual([]);
    saved();
    await vi.waitFor(() => expect(warned).toHaveLength(1));
    expect(warned[0].message).toContain("「♡」");
    expect(warned[0].message).toContain("?");
    expect(warned[0].detail).toContain("控え");

    // 自動保存で毎秒鳴っても、同じ字の組なら窓は1回だけ
    warner.report(report("かきくけ♡あ", ["♡"]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(kept).toHaveLength(1);
    expect(warned).toHaveLength(1);

    // 書けない字が一度無くなったあとに、また打ったら知らせ直す
    warner.forget(report("", []).document);
    warner.report(report("かきくけ♡", ["♡"]));
    await vi.waitFor(() => expect(kept).toHaveLength(2));
  });

  it("控えを取れなかったときも、窓では知らせる（控えが無いことを書く）", async () => {
    const warned: string[] = [];
    const warner = createUnencodableWarner({
      keep: async () => undefined,
      whenSaved: async () => undefined,
      warn: async (_message, detail) => {
        warned.push(detail);
        return undefined;
      },
      openKeep: () => undefined,
      log: () => undefined,
    });
    warner.report(report("♡", ["♡"]));
    await vi.waitFor(() => expect(warned).toHaveLength(1));
    expect(warned[0]).toContain("控えを残せませんでした");
  });
});
