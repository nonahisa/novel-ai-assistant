import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 飛び先を「どの列」に開くか（作者の報告、2026-09-19）。
 *
 * 「該当場所へのリンクをクリックすると、左の画面ではなく右の画面が動きます」
 * ——シーンメモのパネルは `ViewColumn.Beside`（原稿の右）に住む。そこから
 * 本文へ飛ぶと、列を指定していないために**パネルと同じ列へ原稿が開き**、
 * 書いていた左の面が置き去りになっていた。
 *
 * **下段の提案パネル（WebviewView）からの道は、これまでどおりでなければ
 * ならない。** あちらは編集の列を占めないので、「いま前面の列」＝原稿の列で
 * たまたま正しく動いていた。片方だけ直すともう片方が壊れる。
 */

const hoisted = vi.hoisted(() => {
  /** タブの中身。`instanceof` で見分けるので、本物と同じくクラスにする */
  class TabInputText {
    constructor(readonly uri: unknown) {}
  }
  class TabInputCustom {
    constructor(
      readonly uri: unknown,
      readonly viewType: string
    ) {}
  }
  class TabInputNotebook {
    constructor(
      readonly uri: unknown,
      readonly notebookType: string
    ) {}
  }
  class TabInputWebview {
    constructor(readonly viewType: string) {}
  }

  interface FakeTab {
    input: unknown;
  }
  interface FakeGroup {
    viewColumn: number;
    isActive: boolean;
    activeTab?: FakeTab;
    tabs: FakeTab[];
  }

  return {
    TabInputText,
    TabInputCustom,
    TabInputNotebook,
    TabInputWebview,
    state: {
      groups: [] as FakeGroup[],
      shown: [] as Array<{ viewColumn?: number; preserveFocus?: boolean }>,
    },
  };
});

const logged: string[] = [];
vi.mock("../../../src/core/logger", () => ({
  logStep: (message: string) => {
    logged.push(message);
  },
  useLogFile: () => undefined,
}));

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const window = actual.window as Record<string, unknown>;
  const workspace = actual.workspace as Record<string, unknown>;
  return {
    ...actual,
    TabInputText: hoisted.TabInputText,
    TabInputCustom: hoisted.TabInputCustom,
    TabInputNotebook: hoisted.TabInputNotebook,
    TabInputWebview: hoisted.TabInputWebview,
    Selection: class {
      constructor(
        readonly start: unknown,
        readonly end: unknown
      ) {}
    },
    TextEditorRevealType: { InCenter: 2 },
    window: {
      ...window,
      get tabGroups() {
        return {
          all: hoisted.state.groups,
          activeTabGroup: hoisted.state.groups.find((group) => group.isActive),
        };
      },
      showTextDocument: async (
        _doc: unknown,
        options: { viewColumn?: number; preserveFocus?: boolean }
      ) => {
        hoisted.state.shown.push(options);
        return {
          selection: undefined,
          revealRange: () => undefined,
        };
      },
    },
    workspace: {
      ...workspace,
      openTextDocument: async () => ({
        lineCount: 100,
        lineAt: () => ({ range: { start: 0, end: 0 } }),
      }),
    },
  };
});

const vscode = await import("vscode");
const { revealTextLocation } = await import("../../../src/features/revealLocation");

const MANUSCRIPT = "C:/小説/いじめられっ子/本文/2.md";
const OTHER = "C:/小説/いじめられっ子/本文/1.md";

function textTab(location: string): { input: unknown } {
  return { input: new hoisted.TabInputText(vscode.Uri.file(location)) };
}

function manuscriptTab(location: string): { input: unknown } {
  return {
    input: new hoisted.TabInputCustom(
      vscode.Uri.file(location),
      "novelai.manuscript"
    ),
  };
}

function panelTab(): { input: unknown } {
  return { input: new hoisted.TabInputWebview("novelai.sceneMemos") };
}

/** 左に原稿、右にシーンメモのパネル（パネルが前面） */
function besidePanelLayout(openInLeft: string): void {
  const left = manuscriptTab(openInLeft);
  const panel = panelTab();
  hoisted.state.groups = [
    { viewColumn: 1, isActive: false, activeTab: left, tabs: [left] },
    { viewColumn: 2, isActive: true, activeTab: panel, tabs: [panel] },
  ];
}

beforeEach(() => {
  logged.length = 0;
  hoisted.state.groups = [];
  hoisted.state.shown.length = 0;
});

describe("シーンメモのパネルから飛ぶ", () => {
  it("原稿の列へ開く（パネルのある列ではない）", async () => {
    besidePanelLayout(OTHER);

    await revealTextLocation(MANUSCRIPT, 5, undefined, "シーンメモ");

    expect(hoisted.state.shown).toHaveLength(1);
    expect(hoisted.state.shown[0].viewColumn).toBe(1);
  });

  it("既にその本文が開いている列があれば、そこへ開く", async () => {
    // 作者が2列目に原稿を置いていることがある。**置いた場所を動かさない**
    const open = textTab(MANUSCRIPT);
    const panel = panelTab();
    hoisted.state.groups = [
      { viewColumn: 1, isActive: false, activeTab: undefined, tabs: [] },
      { viewColumn: 2, isActive: false, activeTab: open, tabs: [open] },
      { viewColumn: 3, isActive: true, activeTab: panel, tabs: [panel] },
    ];

    await revealTextLocation(MANUSCRIPT, 5, undefined, "シーンメモ");

    expect(hoisted.state.shown[0].viewColumn).toBe(2);
  });

  it("ほかに列が無ければ、パネルの横へ開く（パネルの上に重ねない）", async () => {
    const panel = panelTab();
    hoisted.state.groups = [
      { viewColumn: 1, isActive: true, activeTab: panel, tabs: [panel] },
    ];

    await revealTextLocation(MANUSCRIPT, 5, undefined, "シーンメモ");

    expect(hoisted.state.shown[0].viewColumn).toBe(vscode.ViewColumn.Beside);
  });

  it("どの列を選んだかを記録に残す", async () => {
    besidePanelLayout(OTHER);

    await revealTextLocation(MANUSCRIPT, 5, undefined, "シーンメモ");

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("シーンメモ");
    expect(logged[0]).toContain("列");
  });
});

describe("下段の提案パネルから飛ぶ（これまでどおり）", () => {
  it("前面が本文のタブなら、列を指定しない", async () => {
    // 下段の WebviewView は編集の列を占めないので、前面の列は本文のまま。
    // ここで列を指定すると、これまで正しく動いていた道を触ることになる
    const open = textTab(OTHER);
    hoisted.state.groups = [
      { viewColumn: 1, isActive: true, activeTab: open, tabs: [open] },
    ];

    await revealTextLocation(MANUSCRIPT, 5, undefined, "提案パネル");

    expect(hoisted.state.shown[0].viewColumn).toBeUndefined();
  });

  it("前面が原稿エディタでも、列を指定しない", async () => {
    const open = manuscriptTab(OTHER);
    hoisted.state.groups = [
      { viewColumn: 1, isActive: true, activeTab: open, tabs: [open] },
    ];

    await revealTextLocation(MANUSCRIPT, 5, undefined, "提案パネル");

    expect(hoisted.state.shown[0].viewColumn).toBeUndefined();
  });

  it("タブを読めない環境でも、これまでどおり開ける", async () => {
    // 古いVS Code・試験の代役では `tabGroups` が空になる。
    // **列を決められないことを理由に飛べなくしない**
    hoisted.state.groups = [];

    await revealTextLocation(MANUSCRIPT, 5, undefined, "提案パネル");

    expect(hoisted.state.shown).toHaveLength(1);
    expect(hoisted.state.shown[0].viewColumn).toBeUndefined();
  });
});
