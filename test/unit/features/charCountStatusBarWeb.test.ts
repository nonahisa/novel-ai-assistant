import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * ブラウザ版で、本文を開いても下の欄（ステータスバー）に種類の目安と
 * 今日の執筆量が出なかった（2026-09-24、test-web〔VS Code 1.140〕の実機）。
 *
 * 1. 作品の引き当てが外れていた。登録簿の場所は生の日本語
 *    （`vscode-test-web://mount/仮作品`）、開いた本文の場所は
 *    `paths.fromUri(document.uri)` で日本語が符号化される
 *    （`vscode-test-web://mount/%E4%BB%AE…/episode_0001.txt`）
 * 2. 吹き出しの先頭の名前が `\仮作品\episode_0001.txt` と、道まるごと出ていた。
 *    `document.fileName`（＝ `uri.fsPath`。Windows のブラウザでは `\` 区切り）
 *    から名前を取っており、**ブラウザ束の `path` は posix**
 *    （`esbuild.js` の `path` → `path-browserify`）なので `\` で割れなかった
 *
 * 2 を手元の Node（Windows）で再現するため、`path` をブラウザ束と同じ
 * posix に差し替える。**このファイルだけ**で差し替える（ほかのテストの
 * `path` まで posix にすると、Windows の道のテストが意味を失う）。
 */

vi.mock("path", async () => {
  const actual = await vi.importActual<typeof import("path")>("path");
  return { ...actual.posix, default: actual.posix };
});

const state = vi.hoisted(() => ({
  activeTextEditor: undefined as unknown,
  item: { text: "", tooltip: undefined as unknown },
}));

vi.mock("vscode", () => {
  const noop = () => ({ dispose() {} });
  return {
    StatusBarAlignment: { Left: 1, Right: 2 },
    MarkdownString: class {
      constructor(readonly value = "") {}
    },
    Uri: {
      file: (fsPath: string) => ({ scheme: "file", fsPath }),
      parse: (value: string) => ({ scheme: "file", fsPath: value }),
    },
    EventEmitter: class {
      event = noop;
      fire() {}
      dispose() {}
    },
    window: {
      createStatusBarItem: () => ({
        get text() {
          return state.item.text;
        },
        set text(value: string) {
          state.item.text = value;
        },
        set tooltip(value: unknown) {
          state.item.tooltip = value;
        },
        show() {},
        hide() {},
        dispose() {},
      }),
      onDidChangeActiveTextEditor: noop,
      onDidChangeTextEditorSelection: noop,
      get activeTextEditor() {
        return state.activeTextEditor;
      },
    },
    workspace: {
      onDidChangeTextDocument: noop,
      getConfiguration: () => ({
        get: <T>(_key: string, defaultValue: T): T => defaultValue,
      }),
    },
  };
});

import { CharCountStatusBar } from "../../../src/features/charCountStatusBar";
import { findWorkForFile } from "../../../src/core/workRegistry";

/** 実機で見た形そのまま */
const FOLDER = "vscode-test-web://mount/仮作品";
const OPENED =
  "vscode-test-web://mount/%E4%BB%AE%E4%BD%9C%E5%93%81/episode_0001.txt";
const FS_PATH = "\\仮作品\\episode_0001.txt";

const work = {
  id: "w1",
  title: "仮作品",
  folderPath: FOLDER,
  registeredAt: "2026-09-24T00:00:00.000Z",
};

const summary = {
  today: "2026-09-24",
  todayProgress: { written: 120, goal: 0, remaining: 0, rate: 0, achieved: false },
  monthProgress: { written: 800, goal: 0, remaining: 0, rate: 0, achieved: false },
  monthActiveDays: 3,
  streak: 2,
};

function webEditor(text: string) {
  const document = {
    fileName: FS_PATH,
    uri: {
      scheme: "vscode-test-web",
      authority: "mount",
      path: "/仮作品/episode_0001.txt",
      fsPath: FS_PATH,
      toString: () => OPENED,
    },
    getText: () => text,
  };
  return { document, selection: { isEmpty: true } };
}

function tooltipText(): string {
  const tooltip = state.item.tooltip as { value?: string } | undefined;
  return tooltip?.value ?? "";
}

let bar: CharCountStatusBar | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  state.item.text = "";
  state.item.tooltip = undefined;
});

afterEach(() => {
  bar?.dispose();
  bar = undefined;
  vi.useRealTimers();
});

describe("ブラウザ版の作品（URI）の本文を開いたとき", () => {
  test("作品を引き当て、種類の目安と今日の執筆量を出す", async () => {
    state.activeTextEditor = webEditor("あ".repeat(11));
    const kindOf = vi.fn(async () => "essay" as const);
    bar = new CharCountStatusBar({
      findWork: (filePath) => findWorkForFile([work], filePath),
      summary: async () => summary,
      kindOf,
    });
    bar.refreshNow();
    await vi.runAllTimersAsync();

    expect(kindOf).toHaveBeenCalledTimes(1);
    expect(state.item.text).toContain("11字（読了 約1分）");
    expect(state.item.text).toContain("今日 +120字");
    expect(tooltipText()).toContain("仮作品");
  });

  test("吹き出しの先頭は、ファイルの名前だけ（道や \\ を出さない）", async () => {
    state.activeTextEditor = webEditor("あ".repeat(11));
    bar = new CharCountStatusBar({
      findWork: () => undefined,
      summary: async () => undefined,
    });
    bar.refreshNow();
    await vi.runAllTimersAsync();

    const firstLine = tooltipText().split("\n")[0];
    expect(firstLine).toBe("**episode_0001.txt**");
  });

  test("日本語のファイル名は、符号を解いて出す", async () => {
    const editor = webEditor("本文");
    editor.document.uri.toString = () =>
      "vscode-test-web://mount/%E4%BB%AE%E4%BD%9C%E5%93%81/%E7%AC%AC1%E8%A9%B1.txt";
    editor.document.fileName = "\\仮作品\\第1話.txt";
    state.activeTextEditor = editor;
    bar = new CharCountStatusBar({
      findWork: () => undefined,
      summary: async () => undefined,
    });
    bar.refreshNow();
    await vi.runAllTimersAsync();

    expect(tooltipText().split("\n")[0]).toBe("**第1話.txt**");
  });
});
