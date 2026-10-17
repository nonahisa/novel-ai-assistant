import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 推敲の「冗長」で修正案が空の指摘を［適用］しても、本文を空へ置き換えない
 * （作者の裁定 2026-10-17「直しの案を出させる」の、それでも空だったときの守り。A23）。
 *
 * 実データ（ハイエルフ全17話・26b）で、冗長10件のうち6件が修正案なしで通った。
 * 画面は修正案の無い指摘に［適用］を出さないが、**押す口（`apply` の知らせ）が
 * 届いたときの守りが無かった**——まとめて適用の対象外にしているのと同じく、
 * 1件ずつの適用でも書き換えない。
 */

let text = "";

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn(),
      visibleTextEditors: [],
      createOutputChannel: () => ({
        appendLine: noop,
        show: noop,
        dispose: noop,
      }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: { readFile: vi.fn(), writeFile: vi.fn(), createDirectory: vi.fn() },
      textDocuments: [],
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    EventEmitter: class {
      event = () => ({ dispose: noop });
      fire = noop;
    },
    ThemeIcon: class {},
    ThemeColor: class {},
    MarkdownString: class {},
    Range: class {},
    Position: class {},
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    ViewColumn: { One: 1 },
  };
});

const writes = vi.fn(async (_path: string, next: string) => {
  text = next;
  return { ok: true };
});
vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text,
    hash: "h",
    encoding: "utf8",
    eol: "\n",
    bom: false,
  })),
  sameFilePath: () => false,
  writeTextFilePreservingFormat: (path: string, next: string) => writes(path, next),
}));

vi.mock("../../../src/core/fileLockStore", () => ({
  FileLockStore: class {
    async lockFor(): Promise<undefined> {
      return undefined;
    }
  },
}));

vi.mock("../../../src/core/actorContext", () => ({
  isEditorMode: () => false,
  manualActor: () => "author",
  recordEdit: vi.fn(async () => undefined),
}));

import { ProposalPanel } from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "ハイエルフ未亡人",
  folderPath: "C:/小説/ハイエルフ",
  registeredAt: "2026-10-17T00:00:00.000Z",
};

const line = "　ダラダラと汗まみれになりながら、坂を上った。";
const original = `${line}\n　夜が明けた。\n`;

/** 26b が返した形：冗長の札で、修正案が空 */
const redundant = {
  filePath: "C:/小説/ハイエルフ/12.txt",
  chunkHash: "h1",
  line: 1,
  original: "ダラダラと汗まみれになりながら、坂を上った。",
  target: "ダラダラと汗まみれになりながら、坂を上った。",
  suggestion: "",
  reason: "冗長",
  confidence: "medium" as const,
  explanation: "「ダラダラと」と「汗まみれ」が重なっています",
};

function fakeView() {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: () => Promise.resolve(true),
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

beforeEach(() => {
  text = original;
  writes.mockClear();
});

describe("修正案の無い推敲の指摘", () => {
  test("［適用］の知らせが届いても、本文を書き換えず、適用済みにもしない", async () => {
    const panel = new ProposalPanel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.resolveWebviewView(fakeView() as any);
    panel.showResults(work, [redundant], "推敲");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = (panel as any).items[0];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handleMessage({ type: "apply", id: item.id });

    expect(text).toBe(original);
    expect(writes).not.toHaveBeenCalled();
    expect(item.status).not.toBe("applied");
  });
});
