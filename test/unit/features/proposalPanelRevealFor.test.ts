import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 校正・メモパネルの［提案パネル］から開いたとき、**押したパネルの作品**の
 * 提案パネルが前に出ること（作者の実機 2026-11-02）。
 *
 * 「たゆたう鉛 - 実験用」の校正・メモパネルから押すと、提案パネルは
 * 前に見ていた「たゆたう鉛_確認用」のまま開いた。入口が作品を渡さず
 * `reveal()` だけを呼んでいたため。`revealFor(work)` は、作品を切り替えて
 * から前に出す（切り替えのやり方は `switchWork`・`inCategory` と同じ——
 * いま出している分は控えへ戻すので、もう一方の作業は消えない）。
 */

const posted: Array<{ workTitle: string; category: string; items: unknown[] }> = [];

function fakeWebview() {
  return {
    options: {},
    html: "",
    cspSource: "vscode-webview:",
    onDidReceiveMessage: () => ({ dispose: () => undefined }),
    postMessage: (message: { workTitle: string; category: string; items: unknown[] }) => {
      posted.push(message);
      return Promise.resolve(true);
    },
  };
}

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      tabGroups: { all: [] },
      createWebviewPanel: vi.fn(() => ({
        webview: fakeWebview(),
        viewColumn: 2,
        active: true,
        reveal: noop,
        onDidDispose: () => ({ dispose: noop }),
      })),
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
    TabInputWebview: class {},
    ThemeIcon: class {},
    ThemeColor: class {},
    MarkdownString: class {},
    Range: class {},
    Position: class {},
    ViewColumn: { One: 1, Beside: -2 },
  };
});

import { ProposalPanel } from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";

const experiment: WorkEntry = {
  id: "w1",
  title: "たゆたう鉛 - 実験用",
  folderPath: "C:/小説/たゆたう鉛 - 実験用",
  registeredAt: "2026-11-02T00:00:00.000Z",
};
const checkCopy: WorkEntry = {
  id: "w2",
  title: "たゆたう鉛_確認用",
  folderPath: "C:/小説/たゆたう鉛_確認用",
  registeredAt: "2026-11-02T00:00:00.000Z",
};

const typoOf = (work: WorkEntry, line: number) => ({
  filePath: `${work.folderPath}/本文/001.txt`,
  chunkHash: `h${line}`,
  line,
  original: "彼は走つた",
  target: "走つた",
  suggestion: "走った",
  reason: "促音の誤り",
  confidence: "high" as const,
});

/** 右の列の提案パネルを開いておく（画面へ送った便りを捕まえるため） */
function openedPanel(): ProposalPanel {
  const panel = new ProposalPanel();
  panel.reveal();
  return panel;
}

function latest() {
  return posted[posted.length - 1];
}

beforeEach(() => {
  posted.length = 0;
});

describe("提案パネルを、渡された作品で前に出す", () => {
  test("別の作品を見ているときに押すと、押した作品の結果へ切り替わる", () => {
    const panel = openedPanel();
    // 先に確認用の結果が出ている（作者が見ていた画面）
    panel.showResults(checkCopy, [typoOf(checkCopy, 3)]);
    // 実験用の結果は届いても画面を奪わない（別の作品の結果）
    panel.showResults(experiment, [typoOf(experiment, 5), typoOf(experiment, 6)]);
    expect(latest().workTitle).toBe("たゆたう鉛_確認用");

    panel.revealFor(experiment);

    expect(latest().workTitle).toBe("たゆたう鉛 - 実験用");
    expect(latest().items).toHaveLength(2);
  });

  test("切り替えても、前の作品の結果は消えない", () => {
    const panel = openedPanel();
    panel.showResults(checkCopy, [typoOf(checkCopy, 3)]);
    panel.showResults(experiment, [typoOf(experiment, 5)]);

    panel.revealFor(experiment);
    panel.revealFor(checkCopy);

    expect(latest().workTitle).toBe("たゆたう鉛_確認用");
    expect(latest().items).toHaveLength(1);
  });

  test("まだ結果の無い作品でも、その作品の（空の）画面にする", () => {
    const panel = openedPanel();
    panel.showResults(checkCopy, [typoOf(checkCopy, 3)]);

    panel.revealFor(experiment);

    // 前の作品の指摘を、押した作品のものとして見せない
    expect(latest().workTitle).toBe("たゆたう鉛 - 実験用");
    expect(latest().items).toHaveLength(0);

    // 戻れば、前の作品の指摘はそのまま
    panel.revealFor(checkCopy);
    expect(latest().items).toHaveLength(1);
  });

  test("同じ作品なら、見ている分類を動かさない", () => {
    const panel = openedPanel();
    panel.showResults(experiment, [typoOf(experiment, 5)], "誤字脱字");
    panel.showResults(experiment, [typoOf(experiment, 7)], "推敲");
    const before = latest().category;

    panel.revealFor(experiment);

    expect(latest().category).toBe(before);
  });
});
