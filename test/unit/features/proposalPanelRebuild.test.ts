import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 窓の大きさを変えると分類タブが消える（実機確認 2026-09-11 07:30、
 * `docs/実機確認リスト.md` 216〜247行）。
 *
 * ①「設定資料の更新 16」「誤字脱字 3」「推敲 67」を溜める
 * ②窓を最大化から元の大きさに戻す（下段の面が組み直される）
 * → **分類タブの行がまるごと消え**、表示中だった推敲しか無いように見える。
 *   印は「提案 86」のままで、数と画面が食い違う。
 *
 * 画面が組み直されると script は最初から走り直すので、**組み直される前に
 * 送った `issues` は誰も受け取らない**。ここで再現し、握手（`ready`）で
 * 送り直すようにしたことを固める。
 */

const posted: Array<Record<string, unknown>> = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: { readFile: vi.fn(), writeFile: vi.fn(), createDirectory: vi.fn() },
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
    ViewColumn: { One: 1 },
  };
});

vi.mock("../../src/core/typoIssueHistory", () => ({
  TypoDismissedHistory: class {
    add = () => Promise.resolve(undefined);
    load = () => Promise.resolve(new Set<string>());
  },
  dismissKey: (filePath: string, item: { line: number }) =>
    `${filePath}:${item.line}`,
  appendAiActionLog: () => Promise.resolve(undefined),
}));

import {
  ProposalPanel,
  type RecordUpdateViewItem,
} from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-06T00:00:00.000Z",
};

const otherWork: WorkEntry = {
  id: "w2",
  title: "もう一つの作品",
  folderPath: "C:/小説/もう一つの作品",
  registeredAt: "2026-09-06T00:00:00.000Z",
};

function issue(line: number) {
  return {
    filePath: "C:/小説/いじめられっ子/本文/001.txt",
    chunkHash: "h1",
    line,
    original: `その上で、その上で${line}`,
    target: "その上で",
    suggestion: "そのうえで",
    reason: "同語反復",
    confidence: "high" as const,
  };
}

function update(index: number, name = "人物"): RecordUpdateViewItem {
  return {
    id: `u${index}`,
    name: `${name}${index}`,
    changes: [`役割: 前 → 後${index}`],
    source: "設定資料の抽出",
    status: "pending",
  };
}

interface Badge {
  value: number;
  tooltip?: string;
}

/**
 * 偽の面。
 *
 * **script が読み込まれる前に送られたものは捨てる。** 本物の webview も
 * 同じで、画面が組み直された直後に送った分は誰も受け取らない。
 * `loadScript()` が、script の読み込み（＝握手）を模す。
 */
function fakeView(options: { scriptLoaded?: boolean } = {}) {
  let badge: Badge | undefined;
  let loaded = options.scriptLoaded !== false;
  const handlers: Array<(message: unknown) => void> = [];
  const view = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        handlers.push(handler);
        return { dispose: () => undefined };
      },
      postMessage: (message: Record<string, unknown>) => {
        if (!loaded) return Promise.resolve(false);
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
    set badge(next: Badge | undefined) {
      badge = next;
    },
    get badge(): Badge | undefined {
      return badge;
    },
  };
  return {
    view,
    /** 画面の script が読み込まれ、「準備できた」と伝える */
    loadScript() {
      loaded = true;
      for (const handler of handlers) handler({ type: "ready" });
    },
  };
}

function lastIssuesMessage(): Record<string, unknown> | undefined {
  return [...posted].reverse().find((message) => message.type === "issues");
}

const ok = () => Promise.resolve({ ok: true });

/** 3分類（設定資料の更新 16 / 誤字脱字 3 / 推敲 67）を溜めたパネルを作る */
function panelWithThreeCategories(loadPending?: () => Promise<void>) {
  const panel = new ProposalPanel(
    undefined,
    undefined,
    undefined,
    loadPending ? () => loadPending() : undefined
  );
  const first = fakeView();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(first.view as any);
  panel.showRecordUpdates(
    work,
    Array.from({ length: 16 }, (_, index) => update(index + 1)),
    ok,
    ok
  );
  panel.showResults(work, [issue(1), issue(2), issue(3)], "誤字脱字");
  panel.showResults(
    work,
    Array.from({ length: 67 }, (_, index) => issue(index + 10)),
    "推敲"
  );
  return { panel, first };
}

beforeEach(() => {
  posted.length = 0;
});

describe("画面が組み直されたとき", () => {
  test("握手のあとに、分類タブが送り直される", () => {
    const { panel } = panelWithThreeCategories();
    expect((lastIssuesMessage()?.categories as unknown[]).length).toBe(3);

    // 窓の大きさを変えると、下段の面は作り直される
    posted.length = 0;
    const second = fakeView({ scriptLoaded: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.resolveWebviewView(second.view as any);
    // 組み直した直後に送ったものは、script がまだ無いので誰も受け取らない
    expect(lastIssuesMessage()).toBeUndefined();

    second.loadScript();

    const message = lastIssuesMessage();
    expect(message?.category).toBe("推敲");
    expect((message?.items as unknown[]).length).toBe(67);
    expect((message?.categories as unknown[]).length).toBe(3);
  });

  test("別の作品の承認待ちが後から届いても、表示中の分類は減らない", async () => {
    let resolvePending: (() => void) | undefined;
    const pendingDone = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    let target: ProposalPanel | undefined;
    const { panel, first } = panelWithThreeCategories(async () => {
      // 承認待ちはディスクから読むので、画面より遅れて届く
      await Promise.resolve();
      target?.showRecordUpdates(
        otherWork,
        [update(1, "別作品の人物"), update(2, "別作品の人物")],
        ok,
        ok,
        "設定資料の更新",
        { quiet: true }
      );
      resolvePending?.();
    });
    target = panel;
    void first;

    posted.length = 0;
    const second = fakeView({ scriptLoaded: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.resolveWebviewView(second.view as any);
    second.loadScript();
    await pendingDone;

    const message = lastIssuesMessage();
    // 表示中は「いじめられっ子」の推敲のまま。別の作品が画面を奪わない
    expect(message?.workTitle).toBe(work.title);
    expect(message?.category).toBe("推敲");
    expect((message?.categories as unknown[]).length).toBe(3);
  });

  test("同じ作品の承認待ちが静かに届いても、見ている分類は動かない", () => {
    const { panel } = panelWithThreeCategories();
    posted.length = 0;

    panel.showRecordUpdates(
      work,
      [update(20), update(21)],
      ok,
      ok,
      "設定資料の更新",
      { quiet: true }
    );

    const message = lastIssuesMessage();
    expect(message?.category).toBe("推敲");
    expect((message?.items as unknown[]).length).toBe(67);
    expect((message?.categories as unknown[]).length).toBe(3);
  });

  /** まだ何も出していないときは、溜まっていた承認待ちを出す（0.45.0の狙い） */
  test("何も出していなければ、静かに届いた承認待ちをそのまま出す", () => {
    const panel = new ProposalPanel();
    const fake = fakeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.resolveWebviewView(fake.view as any);

    panel.showRecordUpdates(
      work,
      [update(1), update(2)],
      ok,
      ok,
      "設定資料の更新",
      { quiet: true }
    );

    const message = lastIssuesMessage();
    expect(message?.category).toBe("設定資料の更新");
    expect((message?.items as unknown[]).length).toBe(2);
  });
});
