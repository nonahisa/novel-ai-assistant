import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 本文を書き込んだあとの読み直し（提案パネルの［適用］［戻す］。0.97.7）。
 *
 * 2026-10-03（広報の動画の撮影で発見）：原稿エディターで話を開いたまま
 * 提案パネルの［適用］を押すと、**原稿の列に同じ話の素のテキストエディターの
 * タブがもう1枚開き**、原稿エディターがその下に隠れた。読み直し
 * （もとの `revertIfOpen`）が、原稿エディターの抱える文書も
 * `vscode.workspace.textDocuments` から拾って `showTextDocument`（常に素の
 * エディターで開く）へ渡していたため。
 *
 * 直したあと：
 * - 原稿エディターで開いているとき（素のタブは無い）→ **`showTextDocument` を呼ばない。**
 *   原稿を開く共通の口（`vscode.openWith`、既存タブの入口と列）で前へ出してから読み直す
 * - 素のエディターで開いているとき → これまでどおり（列を名指しして前へ出し、読み直す）
 * - 両方開いているとき → 素のタブの道（文書は共有なので原稿エディターも新しくなる）
 *
 * 画面での確かめは `test/e2e/proposalApply.test.ts`。
 */

const calls = vi.hoisted(() => ({
  executed: [] as Array<{ command: string; args: unknown[] }>,
  shown: [] as Array<{ options: unknown }>,
}));

const layout = vi.hoisted(() => {
  type FakeUri = { scheme: string; fsPath: string; path: string; toString(): string };
  const uriOf = (filePath: string): FakeUri => ({
    scheme: "file",
    fsPath: filePath,
    path: "/" + filePath,
    toString: () => "file:///" + filePath,
  });
  class TabInputCustom {
    readonly uri: FakeUri;
    constructor(
      filePath: string,
      readonly viewType: string
    ) {
      this.uri = uriOf(filePath);
    }
  }
  class TabInputText {
    readonly uri: FakeUri;
    constructor(filePath: string) {
      this.uri = uriOf(filePath);
    }
  }
  class TabInputWebview {
    constructor(readonly viewType: string) {}
  }
  return {
    uriOf,
    TabInputCustom,
    TabInputText,
    TabInputWebview,
    groups: [] as Array<{
      viewColumn: number;
      isActive: boolean;
      tabs: Array<{ input: unknown; isActive?: boolean }>;
    }>,
    documents: [] as Array<{ uri: FakeUri; isDirty: boolean }>,
  };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TabInputCustom: layout.TabInputCustom,
    TabInputText: layout.TabInputText,
    TabInputWebview: layout.TabInputWebview,
    TabInputNotebook: class {},
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    commands: {
      executeCommand: (command: string, ...args: unknown[]) => {
        calls.executed.push({ command, args });
        return Promise.resolve(undefined);
      },
    },
    workspace: {
      ...(actual.workspace as Record<string, unknown>),
      get textDocuments() {
        return layout.documents;
      },
    },
    window: {
      ...(actual.window as Record<string, unknown>),
      get tabGroups() {
        return {
          all: layout.groups,
          activeTabGroup: layout.groups.find((group) => group.isActive),
        };
      },
      visibleTextEditors: [],
      showTextDocument: (_document: unknown, options: { viewColumn?: number }) => {
        calls.shown.push({ options });
        return Promise.resolve({
          selection: { start: 0, end: 0 },
          viewColumn: options.viewColumn ?? 1,
          revealRange: () => undefined,
        });
      },
    },
  };
});

import { reloadOpenDocumentAfterWrite } from "../../../src/features/reloadAfterWrite";
import { MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE } from "../../../src/core/manuscriptViewTypes";

const episodePath = "C:/小説/雨の駅/本文/001_雨の駅.txt";

beforeEach(() => {
  calls.executed.length = 0;
  calls.shown.length = 0;
  layout.groups = [];
  layout.documents = [];
});

function openDocument(isDirty = false): void {
  layout.documents = [{ uri: layout.uriOf(episodePath), isDirty }];
}

/** 左に原稿エディター、右に提案パネル（提案パネルが前面）——撮影で起きた並び */
function manuscriptLeftProposalsRight(): void {
  layout.groups = [
    {
      viewColumn: 1,
      isActive: false,
      tabs: [{ input: new layout.TabInputCustom(episodePath, MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE), isActive: true }],
    },
    {
      viewColumn: 2,
      isActive: true,
      tabs: [{ input: new layout.TabInputWebview("mainThreadWebview-novelai.proposals"), isActive: true }],
    },
  ];
}

describe("原稿エディターで開いているとき", () => {
  test("`showTextDocument` を呼ばない（素のエディターのタブを増やさない）", async () => {
    openDocument();
    manuscriptLeftProposalsRight();

    await reloadOpenDocumentAfterWrite(episodePath);

    expect(calls.shown).toEqual([]);
  });

  test("原稿エディターのタブを、その入口と列で前へ出してから読み直す", async () => {
    openDocument();
    manuscriptLeftProposalsRight();

    await reloadOpenDocumentAfterWrite(episodePath);

    const names = calls.executed.map((entry) => entry.command);
    expect(names).toEqual(["vscode.openWith", "workbench.action.files.revert"]);
    const [uri, viewType, column] = calls.executed[0].args as [{ fsPath: string }, string, number];
    // ドライブ文字の大小は道の組み立てで変わる（`paths.toUri`）ので、大小を揃えて比べる
    expect(uri.fsPath.toLowerCase()).toBe(episodePath.toLowerCase());
    expect(viewType).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
    expect(column).toBe(1);
  });

  test("未保存の変更があれば触れない（読み直しは打ちかけを捨てる）", async () => {
    openDocument(true);
    manuscriptLeftProposalsRight();

    await reloadOpenDocumentAfterWrite(episodePath);

    expect(calls.executed).toEqual([]);
    expect(calls.shown).toEqual([]);
  });
});

describe("素のエディターで開いているとき（これまでどおり）", () => {
  test("本文の列を名指しして前へ出し、読み直す", async () => {
    openDocument();
    layout.groups = [
      { viewColumn: 1, isActive: false, tabs: [{ input: new layout.TabInputText(episodePath), isActive: true }] },
      {
        viewColumn: 2,
        isActive: true,
        tabs: [{ input: new layout.TabInputWebview("mainThreadWebview-novelai.proposals"), isActive: true }],
      },
    ];

    await reloadOpenDocumentAfterWrite(episodePath);

    // 読み直したあと、見えているエディターが無ければもう一度同じ列で出す（これまでの道。代役は空）
    expect(calls.shown[0].options).toMatchObject({ viewColumn: 1, preserveFocus: false, preview: false });
    expect(calls.executed.map((entry) => entry.command)).toEqual(["workbench.action.files.revert"]);
  });

  test("素のタブと原稿エディターの両方があれば、素のタブの道を通る", async () => {
    openDocument();
    layout.groups = [
      {
        viewColumn: 1,
        isActive: false,
        tabs: [{ input: new layout.TabInputCustom(episodePath, MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE), isActive: true }],
      },
      { viewColumn: 2, isActive: true, tabs: [{ input: new layout.TabInputText(episodePath), isActive: true }] },
    ];

    await reloadOpenDocumentAfterWrite(episodePath);

    expect(calls.shown.length).toBeGreaterThan(0);
    expect(calls.executed.map((entry) => entry.command)).toEqual(["workbench.action.files.revert"]);
  });
});

test("どこにも開いていなければ何もしない", async () => {
  await reloadOpenDocumentAfterWrite(episodePath);
  expect(calls.executed).toEqual([]);
  expect(calls.shown).toEqual([]);
});
