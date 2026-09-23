import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 一覧が空になったら、下段タブの印も消える（作者の実機報告、2026-09-06）。
 *
 * 推敲の指摘3件をすべて「無視」したところ、見出しは「推敲 0件」に
 * なったのに、**下段タブの印「提案 ❶」が残ったまま**だった。
 * 「一覧を空にする」まで実行しても消えず、作者からは
 * **「永久に消えない1」**に見える。
 *
 * ## 数え方は2つあるが、食い違ってはいなかった
 *
 * 見出しは画面側が表示中の配列から、印は拡張側が控え（`buckets`）から
 * 数える。**どちらも同じ答えを出す**ことは、下の「全部無視すると印が消える」
 * が見張る（この道は最初から通っていた）。
 *
 * ## 消えなかったのは、印の書き込みが握りつぶされるから
 *
 * 印は `WebviewView.badge` へ代入する。VS Code は**その面（WebviewView）に
 * 最後に書いた値**と同じなら、代入をタブまで伝えない。そして面は、
 * パネルを切り替えて開き直すたびに**作り直され、記憶は空から始まる**
 * ——タブの数字だけが前のまま残る。
 *
 * この状態で「残り0件」を書くと、`undefined` は「前と同じ」と見なされて
 * 握りつぶされ、**タブの ❶ は二度と消えない**。「一覧を空にする」を
 * 押しても、書く値はやはり `undefined` なので同じである。
 */

const posted: Array<Record<string, unknown>> = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve("空にする")),
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

/** 見送りの記録（本物はファイルへ書く）。ここでは書かせない */
vi.mock("../../src/core/typoIssueHistory", () => ({
  TypoDismissedHistory: class {
    add = () => Promise.resolve(undefined);
    load = () => Promise.resolve(new Set<string>());
  },
  dismissKey: (filePath: string, item: { line: number }) =>
    `${filePath}:${item.line}`,
  appendAiActionLog: () => Promise.resolve(undefined),
}));

import { ProposalPanel } from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
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

interface Badge {
  value: number;
  tooltip?: string;
}

/** 下段タブが出している数字。**面を開き直しても残る** */
interface Tab {
  badge: Badge | undefined;
}

/**
 * 提案パネルの面の代役。
 *
 * **VS Code の門番まで真似る。** 「前に書いた値と同じなら伝えない」という
 * ふるまいが、この不具合の正体だからである。面を作り直すたびに
 * `written` は空から始まり、タブ（`tab`）は前の値を持ったままになる。
 */
function fakeView(tab: Tab) {
  let written: Badge | undefined;
  let receive: ((message: unknown) => void) | undefined;
  return {
    view: {
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview:",
        onDidReceiveMessage: (handler: (message: unknown) => void) => {
          receive = handler;
          return { dispose: () => undefined };
        },
        postMessage: (message: Record<string, unknown>) => {
          posted.push(message);
          return Promise.resolve(true);
        },
      },
      onDidDispose: () => ({ dispose: () => undefined }),
      set badge(next: Badge | undefined) {
        if (next?.value === written?.value && next?.tooltip === written?.tooltip) {
          // 前と同じなので、タブまで伝えない（＝ここで握りつぶされる）
          return;
        }
        written = next;
        tab.badge = next;
      },
      get badge(): Badge | undefined {
        return written;
      },
    },
    send: (message: unknown) => receive?.(message),
  };
}

/** 見送りはファイルへの記録を挟むので、片付くまで待つ */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  posted.length = 0;
});

describe("提案パネルの印", () => {
  test("全部「無視」すると、印が消える", async () => {
    const tab: Tab = { badge: undefined };
    const panel = new ProposalPanel();
    const fake = fakeView(tab);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.resolveWebviewView(fake.view as any);
    panel.showResults(work, [issue(1), issue(2), issue(3)], "推敲");

    expect(tab.badge?.value).toBe(3);

    for (let index = 0; index < 3; index++) {
      fake.send({ type: "dismiss", id: `h1:${index + 1}:${index}` });
      await settle();
    }

    expect(tab.badge).toBeUndefined();
  });

  test("「一覧を空にする」でも、印が消える", async () => {
    const tab: Tab = { badge: undefined };
    const panel = new ProposalPanel();
    const fake = fakeView(tab);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.resolveWebviewView(fake.view as any);
    panel.showResults(work, [issue(1)], "推敲");

    fake.send({ type: "clearCategory" });
    await settle();

    expect(tab.badge).toBeUndefined();
  });

  /**
   * **これが「永久に消えない1」の正体。**
   *
   * パネルを切り替えて戻すと面は作り直され、「前に何を書いたか」の記憶は
   * 空になる。そのときすでに残り0件だと、`undefined` は「前と同じ」として
   * 握りつぶされ、タブに残った ❶ は二度と消えない。
   */
  test("面を開き直したときも、残り0件なら印を消す", () => {
    const tab: Tab = { badge: { value: 1, tooltip: "未処理：推敲 1件" } };
    const panel = new ProposalPanel();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.resolveWebviewView(fakeView(tab).view as any);

    expect(tab.badge).toBeUndefined();
  });
});
