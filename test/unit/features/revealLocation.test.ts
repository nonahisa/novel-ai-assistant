import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 本文の「その行」へ飛ぶ道（設計書6.37.4）。
 *
 * **ここで見るのは「降りた枝が記録に残るか」だけである。** 年表から話を
 * 押しても何も起きず、通知もログも1行も無くて原因を追えなかった
 * （実機で発見、2026-09-05）。飛べたか飛べなかったかより先に、
 * 「どこで止まったか」が残っていることを守る。
 */

const logged: string[] = [];
vi.mock("../../../src/core/logger", () => ({
  logStep: (message: string) => {
    logged.push(message);
  },
}));

/** 素のエディタで開いたときの editor（選択と転がしを記録する） */
const plain = vi.hoisted(() => ({
  editor: {
    selection: undefined as undefined | { anchor: unknown; active: unknown },
    revealed: [] as unknown[],
  },
}));

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class Selection {
    constructor(
      readonly anchor: unknown,
      readonly active: unknown
    ) {}
  }
  return {
    ...actual,
    Selection,
    TextEditorRevealType: { InCenter: 2 },
    workspace: {
      ...(actual.workspace as Record<string, unknown>),
      openTextDocument: async () => ({
        lineCount: 3,
        lineAt: (index: number) => ({
          range: {
            start: { line: index, character: 0 },
            end: { line: index, character: 5 },
          },
        }),
      }),
    },
    window: {
      ...(actual.window as Record<string, unknown>),
      showTextDocument: async () => ({
        get selection() {
          return plain.editor.selection;
        },
        set selection(value) {
          plain.editor.selection = value;
        },
        revealRange: (range: unknown) => plain.editor.revealed.push(range),
      }),
      showWarningMessage: () => Promise.resolve(undefined),
    },
  };
});

vi.mock("../../../src/features/editorColumn", () => ({
  columnForLocation: () => ({ column: 1, reason: "試験" }),
}));

const { revealTextLocation } = await import("../../../src/features/revealLocation");

beforeEach(() => {
  logged.length = 0;
  plain.editor.selection = undefined;
  plain.editor.revealed.length = 0;
});

/**
 * 素のエディタへ譲ったときも、**行を選ばず行の頭にカーソルを置く**
 * （作者の裁定、2026-10-03。設計書6.25.11）。選んだまま打つと行が消える。
 */
describe("素のエディタで示す", () => {
  it("行の頭にカーソルだけ置き、行は見える所へ転がす", async () => {
    await revealTextLocation("C:/works/ijime/plot.md", 2, async () => false, "年表");

    expect(plain.editor.selection?.anchor).toEqual({ line: 1, character: 0 });
    expect(plain.editor.selection?.active).toEqual({ line: 1, character: 0 });
    expect(plain.editor.revealed).toHaveLength(1);
  });
});

describe("飛び先の記録", () => {
  it("場所が空なら、原稿エディタを呼ばずに理由を残す", async () => {
    const reveal = vi.fn(async () => true);
    await revealTextLocation("", 1, reveal, "年表");

    expect(reveal).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("年表");
    expect(logged[0]).toContain("空");
  });

  it("原稿エディタが引き受けたときも、1行残す", async () => {
    await revealTextLocation("C:/works/ijime/01.txt", 12, async () => true, "年表");

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("C:/works/ijime/01.txt");
    expect(logged[0]).toContain("12行目");
  });
});
