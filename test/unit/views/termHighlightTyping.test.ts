import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 標準エディターで打鍵したときの用語の色付け（作者の報告、2026-09-23）。
 *
 * 「VS Code の標準エディター、日本語IMEと相性が悪いかもしれません。
 * 変換時に入力が飛ぶ現象があります」——標準エディターでは変換中の文字も
 * 打鍵ごとに本文へ入り、`onDidChangeTextDocument` が届く。以前は 150ms 後に
 * 本文の装飾を付け直しており、作品の外のファイルでも打鍵のたびに
 * 空の装飾を付け直していた。
 *
 * ここでは本物の VS Code は動かせないので、打鍵を「本文が変わった知らせ」
 * として送り、`setDecorations` が何回呼ばれたかを数える。
 */

const state = vi.hoisted(() => {
  type Listener = (event: unknown) => void;
  return {
    changeListeners: [] as Listener[],
    activeListeners: [] as Listener[],
    visibleListeners: [] as Listener[],
    activeTextEditor: undefined as unknown,
  };
});

vi.mock("vscode", () => {
  class Position {
    constructor(
      readonly line: number,
      readonly character: number
    ) {}
  }
  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position
    ) {}
  }
  const subscribe =
    (list: Array<(event: unknown) => void>) =>
    (listener: (event: unknown) => void) => {
      list.push(listener);
      return { dispose() {} };
    };
  return {
    Position,
    Range,
    MarkdownString: class {
      value = "";
      supportThemeIcons = false;
      appendMarkdown(text: string) {
        this.value += text;
        return this;
      }
    },
    Uri: {
      file: (fsPath: string) => ({ scheme: "file", fsPath }),
      parse: (value: string) => ({ scheme: "file", fsPath: value }),
    },
    window: {
      createTextEditorDecorationType: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: subscribe(state.activeListeners),
      onDidChangeTextEditorVisibleRanges: subscribe(state.visibleListeners),
      get activeTextEditor() {
        return state.activeTextEditor;
      },
    },
    workspace: {
      onDidChangeTextDocument: subscribe(state.changeListeners),
      onDidSaveTextDocument: () => ({ dispose() {} }),
    },
  };
});

// 設定資料は「灯」という人物1人だけの作品にする（ディスクは読まない）
vi.mock("../../../src/core/characterStore", async () => {
  const { emptyCharacter } = await import("../../../src/models/character");
  return {
    CharacterStore: class {
      async loadAll() {
        return { characters: [emptyCharacter("char_001", "灯")] };
      }
    },
  };
});
vi.mock("../../../src/core/abilityStore", () => {
  const empty = () => ({ loadAll: async () => ({ records: [] }) });
  return {
    createAbilityStore: empty,
    createLocationStore: empty,
    createOrganizationStore: empty,
    AbilitySystemStore: class {
      async load() {
        return { abilityTerm: "能力" };
      }
    },
  };
});
vi.mock("../../../src/core/seriesSettings", () => ({
  clearSeriesCache: () => undefined,
  loadSeriesTerms: async () => [],
}));
vi.mock("../../../src/core/workRegistry", () => ({ WorkRegistry: class {} }));

import {
  HIGHLIGHT_TYPING_PAUSE_MS,
  TermHighlighter,
} from "../../../src/views/termHighlight";
import { TERM_COLORS } from "../../../src/core/termColors";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { WorkEntry } from "../../../src/models/types";

const KIND_COUNT = Object.keys(TERM_COLORS).length;

const workFolder = nodePath.resolve("typing-test-works", "novel");
const work = { id: "work_001", folderPath: workFolder } as WorkEntry;
const registry = { list: () => [work] } as unknown as WorkRegistry;

/** 本文を持つ文書の作り物。`type` で打鍵を模す（末尾に1文字ずつ足す） */
function fakeEditor(filePath: string, initial: string) {
  let text = initial;
  const lines = () => text.split("\n");
  const offsetAt = (pos: { line: number; character: number }) => {
    const all = lines();
    let offset = 0;
    for (let i = 0; i < pos.line; i++) offset += all[i].length + 1;
    return offset + pos.character;
  };
  const positionAt = (offset: number) => {
    const all = lines();
    let rest = offset;
    for (let line = 0; line < all.length; line++) {
      if (rest <= all[line].length) return { line, character: rest };
      rest -= all[line].length + 1;
    }
    const last = all.length - 1;
    return { line: last, character: all[last].length };
  };
  const document = {
    fileName: filePath,
    uri: { scheme: "file", fsPath: filePath },
    get lineCount() {
      return lines().length;
    },
    lineAt: (line: number) => ({
      text: lines()[line],
      range: { end: { line, character: lines()[line].length } },
    }),
    offsetAt,
    positionAt,
    getText: (range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    }) =>
      range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
  };
  const editor = {
    document,
    get visibleRanges() {
      return [
        {
          start: { line: 0, character: 0 },
          end: { line: lines().length - 1, character: 0 },
        },
      ];
    },
    setDecorations: vi.fn(),
  };
  return {
    editor,
    /** 打鍵1回ぶん：本文を書き換えて、変わった知らせを送る */
    type(chars: string) {
      text += chars;
      for (const listener of state.changeListeners) listener({ document });
    },
    /** 行の頭に足す（用語の位置がずれる打鍵） */
    typeAtStart(chars: string) {
      text = chars + text;
      for (const listener of state.changeListeners) listener({ document });
    },
  };
}

/** 10ms おきに20回打つ（変換中の連打を模す） */
async function typeBurst(target: { type(chars: string): void }) {
  for (let i = 0; i < 20; i++) {
    target.type("あ");
    await vi.advanceTimersByTimeAsync(10);
  }
}

let highlighter: TermHighlighter | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  state.changeListeners.length = 0;
  state.activeListeners.length = 0;
  state.visibleListeners.length = 0;
});

afterEach(() => {
  highlighter?.dispose();
  highlighter = undefined;
  vi.useRealTimers();
});

describe("打鍵が止まってから色を付け直す", () => {
  test("10msおきに20回打っても、付け直しは止まったあとの1回だけ", async () => {
    const target = fakeEditor(
      nodePath.join(workFolder, "本文", "001.txt"),
      "灯は本を閉じた。\n"
    );
    state.activeTextEditor = target.editor;
    highlighter = new TermHighlighter(registry);

    await typeBurst(target);
    // 打っている最中には1度も付け直さない
    expect(target.editor.setDecorations).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HIGHLIGHT_TYPING_PAUSE_MS);
    // 種類ごとに1回ずつ、合わせて1回ぶん
    expect(target.editor.setDecorations).toHaveBeenCalledTimes(KIND_COUNT);
  });

  test("変換中の打鍵の間隔（200msおき）でも、途中では付け直さない", async () => {
    // 以前の待ち時間（150ms）は、変換中の打鍵の間隔より短かった。
    // そのため変換の途中で付け直しが割り込んでいた
    const target = fakeEditor(
      nodePath.join(workFolder, "本文", "001.txt"),
      "灯は本を閉じた。\n"
    );
    state.activeTextEditor = target.editor;
    highlighter = new TermHighlighter(registry);

    for (let i = 0; i < 10; i++) {
      target.type("か");
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(target.editor.setDecorations).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HIGHLIGHT_TYPING_PAUSE_MS);
    expect(target.editor.setDecorations).toHaveBeenCalledTimes(KIND_COUNT);
  });

  test("用語の位置が変わらない打鍵では、付け直さない", async () => {
    const target = fakeEditor(
      nodePath.join(workFolder, "本文", "001.txt"),
      "灯は本を閉じた。\n"
    );
    state.activeTextEditor = target.editor;
    highlighter = new TermHighlighter(registry);

    await typeBurst(target);
    await vi.advanceTimersByTimeAsync(HIGHLIGHT_TYPING_PAUSE_MS);
    target.editor.setDecorations.mockClear();

    // 末尾に書き足すだけなら「灯」の位置は同じ。VS Code に何も渡さない
    await typeBurst(target);
    await vi.advanceTimersByTimeAsync(HIGHLIGHT_TYPING_PAUSE_MS);
    expect(target.editor.setDecorations).not.toHaveBeenCalled();
  });

  test("用語の位置がずれたら、その種類だけ付け直す", async () => {
    const target = fakeEditor(
      nodePath.join(workFolder, "本文", "001.txt"),
      "灯は本を閉じた。\n"
    );
    state.activeTextEditor = target.editor;
    highlighter = new TermHighlighter(registry);

    await typeBurst(target);
    await vi.advanceTimersByTimeAsync(HIGHLIGHT_TYPING_PAUSE_MS);
    target.editor.setDecorations.mockClear();

    target.typeAtStart("　");
    await vi.advanceTimersByTimeAsync(HIGHLIGHT_TYPING_PAUSE_MS);
    // 人物の装飾だけが変わる。場所・能力・組織は空のままなので触らない
    expect(target.editor.setDecorations).toHaveBeenCalledTimes(1);
  });

  test("作品の外のファイルで打鍵を重ねても、最初に1度消したあとは何もしない", async () => {
    // 作者が入力飛びを見たのは、作品の外の長い Markdown（docs/ の表）だった
    const target = fakeEditor(
      nodePath.resolve("typing-test-repo", "docs", "メニュー名の短縮案.md"),
      "| 今の名前 | 短い名前 |\n| --- | --- |\n"
    );
    state.activeTextEditor = target.editor;
    highlighter = new TermHighlighter(registry);

    await typeBurst(target);
    await vi.advanceTimersByTimeAsync(HIGHLIGHT_TYPING_PAUSE_MS);
    // 最初の1回：前に付いていたかもしれない装飾を外す
    expect(target.editor.setDecorations).toHaveBeenCalledTimes(KIND_COUNT);
    target.editor.setDecorations.mockClear();

    for (let round = 0; round < 3; round++) {
      await typeBurst(target);
      await vi.advanceTimersByTimeAsync(HIGHLIGHT_TYPING_PAUSE_MS);
    }
    expect(target.editor.setDecorations).not.toHaveBeenCalled();
  });

  test("打鍵中に画面が送られても（最後の行で打つ）、止まるまで待つ", async () => {
    const target = fakeEditor(
      nodePath.join(workFolder, "本文", "001.txt"),
      "灯は本を閉じた。\n"
    );
    state.activeTextEditor = target.editor;
    highlighter = new TermHighlighter(registry);

    for (let i = 0; i < 5; i++) {
      target.type("あ");
      for (const listener of state.visibleListeners) listener({});
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(target.editor.setDecorations).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HIGHLIGHT_TYPING_PAUSE_MS);
    expect(target.editor.setDecorations).toHaveBeenCalledTimes(KIND_COUNT);
  });
});
