import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 原稿を開く共通の口（作者の裁定、2026-10-03「直す」。設計書6.25.11）。
 *
 * 0.96.7 で「行へ飛ぶ」道と読み上げの入口だけを直した。それ以外の開き方
 * ——作品一覧・前後の話・最新話・話の新規作成・統計の行——では、同じ話が
 * 別の入口（縦と横）や別の列で開いていると、VS Code が**同じ原稿の2枚目**を
 * 作った（1.138.0 の観測。同じ入口・同じ列なら前に出すだけで済む）。
 *
 * 2枚の面が同じ文書を抱えると、片方で打った字がもう片方へ送られ、
 * 打ちかけが入れ替わる危なさがある（規則1）。**開く道を1本に寄せ、
 * 同じ原稿のタブがあれば、そのタブの入口と列で開く。**
 */

const executed: Array<{ command: string; args: unknown[] }> = [];

const layout = vi.hoisted(() => {
  class TabInputCustom {
    readonly uri: { scheme: string; fsPath: string; toString(): string };
    constructor(
      filePath: string,
      readonly viewType: string
    ) {
      this.uri = { scheme: "file", fsPath: filePath, toString: () => filePath };
    }
  }
  return {
    TabInputCustom,
    groups: undefined as
      | Array<{
          viewColumn: number;
          isActive: boolean;
          tabs: Array<{ input: unknown; isActive?: boolean }>;
        }>
      | undefined,
  };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TabInputCustom: layout.TabInputCustom,
    commands: {
      executeCommand: (command: string, ...args: unknown[]) => {
        executed.push({ command, args });
        return Promise.resolve(undefined);
      },
    },
    window: {
      ...(actual.window as Record<string, unknown>),
      get tabGroups() {
        if (!layout.groups) throw new Error("タブを読めない環境");
        return {
          all: layout.groups,
          activeTabGroup: layout.groups.find((group) => group.isActive),
        };
      },
    },
  };
});

import { openManuscriptFile } from "../../../src/features/manuscriptTab";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
} from "../../../src/core/manuscriptViewTypes";

const episodePath = "C:/小説/いじめられっ子/本文/002.txt";

beforeEach(() => {
  executed.length = 0;
  layout.groups = undefined;
});

function tab(filePath: string, viewType: string, isActive = true) {
  return { input: new layout.TabInputCustom(filePath, viewType), isActive };
}

describe("同じ原稿のタブがあれば、2枚目を作らない", () => {
  test("縦で開いている話を横の既定で開こうとしても、縦の入口・その列で開く", async () => {
    layout.groups = [
      {
        viewColumn: 1,
        isActive: false,
        tabs: [tab(episodePath, MANUSCRIPT_EDITOR_VIEW_TYPE)],
      },
      { viewColumn: 2, isActive: true, tabs: [{ input: {}, isActive: true }] },
    ];

    await openManuscriptFile(episodePath, MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);

    expect(executed).toHaveLength(1);
    expect(executed[0].command).toBe("vscode.openWith");
    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_VIEW_TYPE);
    expect(executed[0].args[2]).toBe(1);
  });

  test("同じ入口でも、別の列を頼まれたらタブの居る列で開く", async () => {
    layout.groups = [
      { viewColumn: 1, isActive: true, tabs: [{ input: {}, isActive: true }] },
      {
        viewColumn: 2,
        isActive: false,
        tabs: [tab(episodePath, MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE)],
      },
    ];

    // 統計の行は「パネルの隣」を頼む
    await openManuscriptFile(
      episodePath,
      MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
      { viewColumn: -2 }
    );

    expect(executed).toHaveLength(1);
    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
    expect(executed[0].args[2]).toBe(2);
  });

  test("2枚あるなら、前に出ている面を選ぶ", async () => {
    layout.groups = [
      {
        viewColumn: 1,
        isActive: false,
        tabs: [tab(episodePath, MANUSCRIPT_EDITOR_VIEW_TYPE, false)],
      },
      {
        viewColumn: 2,
        isActive: true,
        tabs: [tab(episodePath, MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE, true)],
      },
    ];

    await openManuscriptFile(episodePath, MANUSCRIPT_EDITOR_VIEW_TYPE);

    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
    expect(executed[0].args[2]).toBe(2);
  });

  test("場所を URI で渡しても、同じタブを見つける", async () => {
    layout.groups = [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [tab(episodePath, MANUSCRIPT_EDITOR_VIEW_TYPE)],
      },
    ];
    const uri = new layout.TabInputCustom(episodePath, "").uri;

    await openManuscriptFile(
      uri as unknown as import("vscode").Uri,
      MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
    );

    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_VIEW_TYPE);
  });
});

describe("タブが無ければ、これまでどおり", () => {
  test("別の話のタブは見ない", async () => {
    layout.groups = [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [tab("C:/小説/いじめられっ子/本文/001.txt", MANUSCRIPT_EDITOR_VIEW_TYPE)],
      },
    ];

    await openManuscriptFile(episodePath, MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);

    expect(executed).toHaveLength(1);
    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
    expect(executed[0].args[2]).toBeUndefined();
  });

  test("素のエディタで開いている同じファイルは、数えない", async () => {
    layout.groups = [
      { viewColumn: 1, isActive: true, tabs: [{ input: {}, isActive: true }] },
    ];

    await openManuscriptFile(episodePath, MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE, 1);

    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
    expect(executed[0].args[2]).toBe(1);
  });

  test("タブを読めない環境でも開ける（頼まれた入口・列のまま）", async () => {
    await openManuscriptFile(episodePath, MANUSCRIPT_EDITOR_VIEW_TYPE, 2);

    expect(executed).toHaveLength(1);
    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_VIEW_TYPE);
    expect(executed[0].args[2]).toBe(2);
  });
});
