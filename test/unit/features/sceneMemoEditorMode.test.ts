import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 「ここにメモを足す」の分かれ道（設計書5.6.1.1。作者の指示 2026-11-01）。
 *
 * - **作者モード**：これまでどおり、カーソル行の上に `// ` の行を挿す
 * - **編集者モード**：本文に行を挿さず、その行への意見を提案として置く口へ渡す
 *
 * 入口は2つある——コマンド（`addSceneMemoHere`。キーとメニュー）と、原稿エディターの
 * 右クリック「メモ追加」（`addMemoFromManuscript`）。片方だけ分けると、もう片方から
 * 編集部が本文を書き換えてしまうので、両方を確かめる。
 */

const inserted: Array<{ line: number; text: string }> = [];
let editorMode = false;
let activeEditor: unknown = undefined;

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class WorkspaceEdit {
    insert(_uri: unknown, position: { line: number }, text: string): void {
      inserted.push({ line: position.line, text });
    }
  }
  return {
    ...actual,
    WorkspaceEdit,
    workspace: {
      ...(actual.workspace as Record<string, unknown>),
      applyEdit: async () => true,
    },
    window: new Proxy(actual.window as Record<string, unknown>, {
      get(target, key) {
        if (key === "activeTextEditor") return activeEditor;
        return target[key as string];
      },
    }),
  };
});

vi.mock("../../../src/core/actorContext", () => ({
  isEditorMode: () => editorMode,
  manualActor: () => (editorMode ? "editor" : "author"),
  recordEdit: vi.fn(async () => undefined),
}));

const { addSceneMemoHere } = await import("../../../src/features/sceneMemoCommand");
const { addMemoFromManuscript } = await import("../../../src/features/manuscriptEditor");

function fakeDocument(lineCount: number) {
  return {
    uri: { fsPath: "C:/小説/本文/1.md", toString: () => "file:///1.md" },
    lineCount,
  } as unknown as Parameters<typeof addMemoFromManuscript>[0];
}

function fakeEditor(line: number) {
  const at = { line, character: 0 };
  return {
    document: fakeDocument(10),
    selection: { active: at, start: at, end: at },
  };
}

beforeEach(() => {
  inserted.length = 0;
  editorMode = false;
  activeEditor = undefined;
});

describe("コマンドの「ここにメモを足す」", () => {
  test("作者モードでは、今までどおり本文に行を足す", async () => {
    activeEditor = fakeEditor(3);
    const propose = vi.fn(async () => undefined);

    await addSceneMemoHere(propose);

    expect(propose).not.toHaveBeenCalled();
    // 0始まりの3行目＝1始まりの4行目の「上」
    expect(inserted).toEqual([{ line: 3, text: "// \n" }]);
  });

  test("編集者モードでは行を足さず、提案の口へ渡す", async () => {
    editorMode = true;
    activeEditor = fakeEditor(3);
    const propose = vi.fn(async () => undefined);

    await addSceneMemoHere(propose);

    expect(inserted).toEqual([]);
    expect(propose).toHaveBeenCalledTimes(1);
    const [, , kind] = propose.mock.calls[0] as unknown as [unknown, unknown, string];
    expect(kind).toBe("memo");
  });
});

describe("原稿エディターの右クリック「メモ追加」", () => {
  test("作者モードでは、今までどおり本文に行を足す", async () => {
    const propose = vi.fn(async () => undefined);

    await addMemoFromManuscript(fakeDocument(10), 4, propose);

    expect(propose).not.toHaveBeenCalled();
    expect(inserted).toEqual([{ line: 3, text: "// \n" }]);
  });

  test("編集者モードでは行を足さず、その行（0始まり）を提案の口へ渡す", async () => {
    editorMode = true;
    const propose = vi.fn(async () => undefined);

    await addMemoFromManuscript(fakeDocument(10), 4, propose);

    expect(inserted).toEqual([]);
    expect(propose).toHaveBeenCalledTimes(1);
    const [, range, kind] = propose.mock.calls[0] as unknown as [
      unknown,
      { start: { line: number; character: number } },
      string,
    ];
    expect(range.start).toMatchObject({ line: 3, character: 0 });
    expect(kind).toBe("memo");
  });
});
