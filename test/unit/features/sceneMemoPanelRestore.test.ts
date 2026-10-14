import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 校正・メモパネルを、拡張機能ホストの再起動・ウィンドウの再読み込みのあとも
 * 新しい拡張機能が引き取る（作者の裁定 2026-10-15「引き取れるようにする」。
 * 実機確認リスト 156）。
 *
 * 道は2つある（2026-10-15 に母艦の画面テストで確かめた）：
 * - **ウィンドウの再読み込み**：VS Code が `registerWebviewPanelSerializer` の口へ
 *   パネルと画面の控え（`setState`）を渡してくる
 * - **拡張機能ホストの再起動**：パネルは画面に残るが、serializer は**呼ばれない**。
 *   新しい拡張機能から見えるのはタブ（`TabInputWebview`、種類は
 *   `mainThreadWebview-novelai.sceneMemos`）だけで、パネルそのものは掴めない。
 *   そこで同じ列へ開き直し、残ったタブを閉じる
 *
 * どちらも、引き取ったあと行を押すと拡張機能に届く（受け口がつながる）ことを見る。
 * 作品が分からないときは、壊れたまま残さず案内の画面に替える。
 * 画面で押して確かめるのは E2E `restartAndDisconnect.test.ts` の 156。
 */

interface FakePanel {
  title: string;
  viewColumn: number | undefined;
  webview: {
    html: string;
    options: Record<string, unknown>;
    cspSource: string;
    onDidReceiveMessage: (handler: (message: unknown) => void) => { dispose: () => void };
    postMessage: (message: { type: string; data?: Record<string, unknown> }) => Promise<boolean>;
  };
  onDidDispose: (handler: () => void) => { dispose: () => void };
  reveal: () => void;
  dispose: () => void;
  received?: (message: unknown) => void;
  disposed: boolean;
  disposeHandlers: Array<() => void>;
  posted: Array<{ type: string; data?: Record<string, unknown> }>;
}

function fakePanel(title: string, viewColumn?: number): FakePanel {
  const panel: FakePanel = {
    title,
    viewColumn,
    disposed: false,
    disposeHandlers: [],
    posted: [],
    webview: {
      html: "",
      options: {},
      cspSource: "vscode-webview:",
      onDidReceiveMessage: (handler) => {
        panel.received = handler;
        return { dispose: () => undefined };
      },
      postMessage: (message) => {
        panel.posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: (handler) => {
      panel.disposeHandlers.push(handler);
      return { dispose: () => undefined };
    },
    reveal: () => undefined,
    dispose: () => {
      if (panel.disposed) return;
      panel.disposed = true;
      for (const handler of panel.disposeHandlers) handler();
    },
  };
  return panel;
}

const created: Array<{ panel: FakePanel; column: unknown }> = [];
let serializer:
  | { deserializeWebviewPanel: (panel: FakePanel, state: unknown) => Promise<void> }
  | undefined;
const closedTabs: unknown[] = [];
let tabGroupsAll: Array<{ viewColumn: number; tabs: unknown[] }> = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  class TabInputWebview {
    constructor(readonly viewType: string) {}
  }
  class TabInputText {}
  class TabInputCustom {}
  return {
    commands: { executeCommand: vi.fn() },
    TabInputWebview,
    TabInputText,
    TabInputCustom,
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      activeTextEditor: undefined,
      activeColorTheme: { kind: 1 },
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
      createWebviewPanel: (_type: string, title: string, show: { viewColumn: unknown }) => {
        const panel = fakePanel(title);
        created.push({ panel, column: show.viewColumn });
        return panel;
      },
      registerWebviewPanelSerializer: (_type: string, given: typeof serializer) => {
        serializer = given;
        return { dispose: noop };
      },
      tabGroups: {
        get all() {
          return tabGroupsAll;
        },
        close: vi.fn(async (tab: unknown) => {
          closedTabs.push(tab);
          return true;
        }),
      },
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: {
        readFile: vi.fn(async () => {
          throw new Error("FileNotFound");
        }),
        writeFile: vi.fn(async () => undefined),
        createDirectory: vi.fn(async () => undefined),
      },
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    ViewColumn: { One: 1, Two: 2, Beside: -2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
  };
});

const FILE_PATH = "C:/小説/いじめられっ子/本文/003.txt";

vi.mock("../../../src/core/scanner", () => ({
  scanWork: vi.fn(async () => ({
    episodes: [{ filePath: FILE_PATH, fileName: "003.txt", hasConflictMarkers: false }],
  })),
}));

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: "三の一行目。\n// 三のメモ\n三の三行目。\n",
    hash: "h0",
    encoding: "utf8",
    eol: "\n",
    bom: false,
  })),
  writeTextFilePreservingFormat: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: vi.fn(async () => ({})),
}));

vi.mock("../../../src/core/episodeLabel", () => ({
  collectedLabelIndex: () => ({ labelAt: () => "第3話" }),
  episodeTitle: () => "",
  formatChapterLabel: () => "第3話",
  isCollectedFile: () => false,
}));

vi.mock("../../../src/features/manuscriptEditor", () => ({
  lastManuscriptCaret: () => undefined,
  removeMemoLineInOpenManuscript: vi.fn(async () => ({ kind: "not_open" })),
  restoreMemoLineInOpenManuscript: vi.fn(async () => ({ kind: "not_open" })),
}));

vi.mock("../../../src/features/revealLocation", () => ({
  revealTextLocation: vi.fn(async () => undefined),
}));

vi.mock("../../../src/views/openDocument", () => ({
  openGeneratedMarkdown: vi.fn(async () => undefined),
}));

import * as vscode from "vscode";
import {
  registerSceneMemoPanelRestore,
  SCENE_MEMO_VIEW_TYPE,
  workForRestoredPanel,
  type SceneMemoDeps,
} from "../../../src/features/sceneMemoPanel";
import { revealTextLocation } from "../../../src/features/revealLocation";
import type { WorkEntry } from "../../../src/models/types";

const WORK = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
} as unknown as WorkEntry;
const OTHER = {
  id: "w2",
  title: "別の作品",
  folderPath: "C:/小説/別の作品",
} as unknown as WorkEntry;

const works = {
  findWorkById: (id: string) => [WORK, OTHER].find((work) => work.id === id),
  listWorks: () => [WORK, OTHER],
};

function context(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

const deps: SceneMemoDeps = { revealInManuscript: vi.fn(async () => true) };

/** 原稿のタブの入力（中身は見ない。種類だけ違えばよい） */
const textTabInput = (): unknown => new (vscode.TabInputText as unknown as new () => unknown)();

/** 片づけ：前のテストで引き取ったパネルを閉じる（作品ごとに1枚の約束があるため） */
const live: FakePanel[] = [];

beforeEach(() => {
  for (const panel of live.splice(0)) panel.dispose();
  for (const entry of created.splice(0)) entry.panel.dispose();
  serializer = undefined;
  closedTabs.length = 0;
  tabGroupsAll = [];
  vi.mocked(revealTextLocation).mockClear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("workForRestoredPanel（どの作品のパネルか）", () => {
  test("画面の控えの作品 id から戻す", () => {
    expect(workForRestoredPanel({ workId: "w2" }, "校正・メモパネル: いじめられっ子", works)?.id).toBe("w2");
  });

  test("控えが無ければ、タブの題から作品名で戻す", () => {
    expect(workForRestoredPanel(undefined, "校正・メモパネル: いじめられっ子", works)?.id).toBe("w1");
  });

  test("控えの作品が台帳から消えていて、題も合わなければ戻せない", () => {
    expect(workForRestoredPanel({ workId: "gone" }, "校正・メモパネル: 消えた作品", works)).toBeUndefined();
  });

  test("同じ題の作品が2つあれば、当て推量で選ばない", () => {
    const twins = {
      findWorkById: () => undefined,
      listWorks: () => [WORK, { ...WORK, id: "w3" } as WorkEntry],
    };
    expect(workForRestoredPanel(undefined, "校正・メモパネル: いじめられっ子", twins)).toBeUndefined();
  });
});

describe("ウィンドウの再読み込み（serializer の口）", () => {
  test("控えから作品を戻し、受け口がつながる（行を押すと本文へ飛ぶ）", async () => {
    vi.useFakeTimers();
    registerSceneMemoPanelRestore(context(), deps, works);
    vi.useRealTimers();
    expect(serializer).toBeDefined();
    const panel = fakePanel("校正・メモパネル: いじめられっ子", 2);
    live.push(panel);
    await serializer!.deserializeWebviewPanel(panel, { workId: "w1", currentFile: FILE_PATH });

    expect(panel.webview.html).toContain("校正・メモパネル");
    expect(panel.received).toBeDefined();
    panel.received!({ type: "ready" });
    await settle();
    const memos = panel.posted.filter((message) => message.type === "memos");
    expect(memos.length).toBeGreaterThan(0);
    const data = memos[memos.length - 1]!.data!;
    expect(data.title).toBe("校正・メモパネル：いじめられっ子");
    // 次の再読み込みでも戻せるよう、控えに作品を書く
    expect(data.restore).toEqual({ workId: "w1", currentFile: FILE_PATH });

    panel.received!({ type: "reveal", filePath: FILE_PATH, line: 2 });
    await settle();
    expect(revealTextLocation).toHaveBeenCalledWith(FILE_PATH, 2, deps.revealInManuscript, expect.anything(), WORK);
  });

  test("作品が分からなければ、空の案内に替える（受け口は持たない）", async () => {
    registerSceneMemoPanelRestore(context(), deps, works);
    const panel = fakePanel("校正・メモパネル: 消えた作品", 2);
    live.push(panel);
    await serializer!.deserializeWebviewPanel(panel, undefined);

    expect(panel.disposed).toBe(false);
    expect(panel.webview.html).toContain("Ctrl+Alt+M");
    expect(panel.webview.html).not.toContain("<script");
  });

  test("同じ作品のパネルが既にあれば、戻ってきたほうを閉じる（1作品1枚）", async () => {
    registerSceneMemoPanelRestore(context(), deps, works);
    const first = fakePanel("校正・メモパネル: いじめられっ子", 2);
    const second = fakePanel("校正・メモパネル: いじめられっ子", 3);
    live.push(first, second);
    await serializer!.deserializeWebviewPanel(first, { workId: "w1" });
    await serializer!.deserializeWebviewPanel(second, { workId: "w1" });
    expect(first.disposed).toBe(false);
    expect(second.disposed).toBe(true);
  });
});

describe("拡張機能ホストの再起動（残ったタブを開き直す）", () => {
  const orphanTab = (label: string) => ({
    label,
    input: new vscode.TabInputWebview(`mainThreadWebview-${SCENE_MEMO_VIEW_TYPE}`),
  });

  test("残ったタブと同じ列へ開き直して受け口をつなぎ、残ったタブを閉じる", async () => {
    vi.useFakeTimers();
    const tab = orphanTab("校正・メモパネル: いじめられっ子");
    tabGroupsAll = [
      { viewColumn: 1, tabs: [{ label: "003.txt", input: textTabInput() }] },
      { viewColumn: 2, tabs: [tab] },
    ];
    registerSceneMemoPanelRestore(context(), deps, works);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await settle();

    expect(created).toHaveLength(1);
    expect(created[0]!.column).toBe(2);
    expect(closedTabs).toEqual([tab]);
    const panel = created[0]!.panel;
    panel.received!({ type: "ready" });
    await settle();
    panel.received!({ type: "reveal", filePath: FILE_PATH, line: 2 });
    await settle();
    expect(revealTextLocation).toHaveBeenCalledWith(FILE_PATH, 2, deps.revealInManuscript, expect.anything(), WORK);
  });

  test("ほかの画面のタブ・原稿のタブには触らない", async () => {
    vi.useFakeTimers();
    tabGroupsAll = [
      { viewColumn: 1, tabs: [{ label: "003.txt", input: textTabInput() }] },
      { viewColumn: 2, tabs: [{ label: "提案", input: new vscode.TabInputWebview("mainThreadWebview-novelai.proposals") }] },
    ];
    registerSceneMemoPanelRestore(context(), deps, works);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await settle();
    expect(created).toHaveLength(0);
    expect(closedTabs).toHaveLength(0);
  });

  test("作品が分からないタブは、案内の画面に替えて閉じる（押しても誰も受けない画面を残さない）", async () => {
    vi.useFakeTimers();
    const tab = orphanTab("校正・メモパネル: 消えた作品");
    tabGroupsAll = [{ viewColumn: 2, tabs: [tab] }];
    registerSceneMemoPanelRestore(context(), deps, works);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await settle();
    expect(created).toHaveLength(1);
    expect(created[0]!.panel.webview.html).toContain("Ctrl+Alt+M");
    expect(closedTabs).toEqual([tab]);
  });
});
