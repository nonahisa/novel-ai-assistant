import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * ステータスバーの字数を、打鍵が止まってから数える（作者の報告、2026-09-23）。
 *
 * 以前は打鍵のたびに、その場で本文全体の字数を数えていた（`extension.ts`
 * の `updateStatusBar`）。長い話ほど1回が重く、日本語の変換中の打鍵を
 * 取りこぼす原因になる。作者が入力飛びを見たのは作品の外の長い Markdown
 * だったが、.md は作品の外でも数えるので、そこにも効かなければならない。
 */

const state = vi.hoisted(() => {
  type Listener = (event: unknown) => void;
  return {
    changeListeners: [] as Listener[],
    selectionListeners: [] as Listener[],
    activeListeners: [] as Listener[],
    activeTextEditor: undefined as unknown,
    item: { text: "", tooltip: undefined as unknown, shown: 0 },
  };
});

vi.mock("vscode", () => {
  const subscribe =
    (list: Array<(event: unknown) => void>) =>
    (listener: (event: unknown) => void) => {
      list.push(listener);
      return { dispose() {} };
    };
  return {
    StatusBarAlignment: { Left: 1, Right: 2 },
    MarkdownString: class {
      constructor(readonly value = "") {}
    },
    Uri: {
      file: (fsPath: string) => ({ scheme: "file", fsPath }),
      parse: (value: string) => ({ scheme: "file", fsPath: value }),
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
        show() {
          state.item.shown++;
        },
        hide() {},
        dispose() {},
      }),
      onDidChangeActiveTextEditor: subscribe(state.activeListeners),
      onDidChangeTextEditorSelection: subscribe(state.selectionListeners),
      get activeTextEditor() {
        return state.activeTextEditor;
      },
    },
    workspace: {
      onDidChangeTextDocument: subscribe(state.changeListeners),
      getConfiguration: () => ({
        get: <T>(_key: string, defaultValue: T): T => defaultValue,
      }),
    },
  };
});

// 数えた回数を見るため、本物の数え方を包む
vi.mock("../../../src/core/charCount", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../src/core/charCount")>();
  return { ...original, countChars: vi.fn(original.countChars) };
});

import {
  CharCountStatusBar,
  STATUS_BAR_TYPING_PAUSE_MS,
} from "../../../src/features/charCountStatusBar";
import { countChars } from "../../../src/core/charCount";

const countSpy = vi.mocked(countChars);

function fakeEditor(filePath: string, initial: string) {
  let text = initial;
  const document = {
    fileName: filePath,
    uri: { scheme: "file", fsPath: filePath },
    getText: () => text,
  };
  const editor = { document, selection: { isEmpty: true } };
  return {
    editor,
    type(chars: string) {
      text += chars;
      for (const listener of state.changeListeners) listener({ document });
      // 打鍵ではカーソルも動く
      for (const listener of state.selectionListeners) {
        listener({ textEditor: editor });
      }
    },
  };
}

let bar: CharCountStatusBar | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  countSpy.mockClear();
  state.changeListeners.length = 0;
  state.selectionListeners.length = 0;
  state.activeListeners.length = 0;
  state.item.text = "";
});

afterEach(() => {
  bar?.dispose();
  bar = undefined;
  vi.useRealTimers();
});

describe("ステータスバーの字数は、打鍵が止まってから数える", () => {
  test("10msおきに20回打っても、数えるのは止まったあとの1回だけ", async () => {
    // 作者が入力飛びを見たのと同じ、作品の外の .md
    const target = fakeEditor(
      nodePath.resolve("typing-test-repo", "docs", "メニュー名の短縮案.md"),
      "本文"
    );
    state.activeTextEditor = target.editor;
    bar = new CharCountStatusBar({
      findWork: () => undefined,
      summary: async () => undefined,
    });

    for (let i = 0; i < 20; i++) {
      target.type("あ");
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(countSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STATUS_BAR_TYPING_PAUSE_MS);
    expect(countSpy).toHaveBeenCalledTimes(1);
    // 数えた結果は、打ち終えた本文のもの（2 + 20 字）
    expect(state.item.text).toContain("22");
  });

  test("ファイルを切り替えたときは、待たずにすぐ出す", () => {
    const target = fakeEditor(
      nodePath.resolve("typing-test-repo", "本文", "001.txt"),
      "灯は本を閉じた。"
    );
    state.activeTextEditor = target.editor;
    bar = new CharCountStatusBar({
      findWork: () => undefined,
      summary: async () => undefined,
    });

    for (const listener of state.activeListeners) listener(target.editor);
    expect(countSpy).toHaveBeenCalledTimes(1);
  });

  test("保存などから呼ぶ refreshNow は、待っている分を捨てて1回だけ数える", async () => {
    const target = fakeEditor(
      nodePath.resolve("typing-test-repo", "本文", "001.txt"),
      "灯"
    );
    state.activeTextEditor = target.editor;
    bar = new CharCountStatusBar({
      findWork: () => undefined,
      summary: async () => undefined,
    });

    target.type("は");
    bar.refreshNow();
    expect(countSpy).toHaveBeenCalledTimes(1);

    // 打鍵ぶんの予約は捨ててあるので、あとから2度目は走らない
    await vi.advanceTimersByTimeAsync(STATUS_BAR_TYPING_PAUSE_MS * 2);
    expect(countSpy).toHaveBeenCalledTimes(1);
  });
});
