import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 設定資料の更新を出しているときに、あとから届いた指摘が出ない
 * （実機確認 2026-09-07 12:08、A節）。
 *
 * ①「更新分を反映（承認制）」で「設定資料の更新 10件」を出す
 * ②そのまま「推敲する」→ 完了の知らせは「指摘 3件」と言うのに、
 *   **パネルは「設定資料の更新 10件」のまま。分類タブも出ず、印も 10 のまま。**
 *
 * 作者から見ると「推敲したのに何も出ない」。ここで再現し、直ったことを固める。
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

import * as vscode from "vscode";
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

function update(index: number): RecordUpdateViewItem {
  return {
    id: `u${index}`,
    name: `人物${index}`,
    changes: [`役割: 前 → 後${index}`],
    source: "設定資料の抽出",
    status: "pending",
  };
}

interface Badge {
  value: number;
  tooltip?: string;
}

function fakeView() {
  let badge: Badge | undefined;
  return {
    view: {
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview:",
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
        postMessage: (message: Record<string, unknown>) => {
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
    },
  };
}

function lastIssuesMessage(): Record<string, unknown> | undefined {
  return [...posted].reverse().find((message) => message.type === "issues");
}

beforeEach(() => {
  posted.length = 0;
});

describe("設定資料の更新のあとに届いた指摘", () => {
  test("推敲の結果が前面に出て、タブと印が増える", () => {
    const panel = new ProposalPanel();
    const fake = fakeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.resolveWebviewView(fake.view as any);

    const ok = () => Promise.resolve({ ok: true });
    panel.showRecordUpdates(
      work,
      Array.from({ length: 10 }, (_, index) => update(index + 1)),
      ok,
      ok
    );
    expect(lastIssuesMessage()?.category).toBe("設定資料の更新");
    expect(fake.view.badge?.value).toBe(10);

    const shown = panel.showResults(work, [issue(1), issue(2), issue(3)], "推敲");
    expect(shown.remaining).toBe(3);

    const message = lastIssuesMessage();
    expect(message?.category).toBe("推敲");
    expect((message?.items as unknown[]).length).toBe(3);
    // 2つの分類があるので、切り替えのタブが出る
    expect((message?.categories as unknown[]).length).toBe(2);
    // 印は両方の残りを足した数
    expect(fake.view.badge?.value).toBe(13);
  });

  /**
   * **同じ作品でも id が変わる経路がある**（登録し直し・書庫の子作品）。
   * id で置き場を引くと、あとから来た推敲が「別の作品の結果」と見なされ、
   * 「表示する」の知らせだけ出て一覧もタブも印も変わらなかった（実機、2026-09-07）。
   * 置き場は作品フォルダーで引く。
   */
  test("id が違っても、同じフォルダーなら同じ作品として足す", () => {
    const panel = new ProposalPanel();
    const fake = fakeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.resolveWebviewView(fake.view as any);

    const ok = () => Promise.resolve({ ok: true });
    panel.showRecordUpdates(work, [update(1), update(2)], ok, ok);
    const reRegistered: WorkEntry = { ...work, id: "w1-again" };
    const shown = panel.showResults(reRegistered, [issue(1)], "推敲");
    expect(shown.remaining).toBe(1);

    const message = lastIssuesMessage();
    expect(message?.category).toBe("推敲");
    expect((message?.categories as unknown[]).length).toBe(2);
    expect(fake.view.badge?.value).toBe(3);
    // 別の作品の知らせ（「表示する」）は出ない
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});
