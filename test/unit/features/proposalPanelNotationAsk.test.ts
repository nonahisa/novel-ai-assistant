import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 表記ゆれの「AIに訊く」（P-33、設計書6.73）。
 *
 * AIの答えは数十秒かかる。**その間に同じ分類の再チェックが走ると、
 * 一覧の配列が新しいものへ差し替わる**（`replaceContents` →
 * `mergeProposals` は、まだ手を付けていない指摘を新しい中身で置き換える）。
 * 掴んだままの `item` へ書き戻すと、答えは**捨てられた側の物**に付き、
 * 画面には何も出ないまま「AIに訊く」が押せる状態へ戻る。
 *
 * idは決定的（chunkHash・行・並び）なので、書き戻すときに引き直せばよい。
 */

const posted: Array<{ items?: unknown[] }> = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(async () => undefined),
      showInformationMessage: vi.fn(async () => undefined),
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

/** 何を訊いて何が返ったかの記録。ここでは配線を見ないので黙らせる */
vi.mock("../../src/core/typoIssueHistory", () => ({
  appendAiActionLog: vi.fn(async () => undefined),
  readTypoIssueHistory: vi.fn(async () => []),
}));

/** AIの答えを、テスト側の合図で返せるようにする */
const advice = vi.hoisted(() => ({
  resolve: undefined as ((value: unknown) => void) | undefined,
}));

vi.mock("../../src/features/notationAdvice", () => ({
  askNotationAdvice: vi.fn(
    () =>
      new Promise((resolve) => {
        advice.resolve = resolve;
      })
  ),
  describeNotationAdvice: (a: { choice: string }) =>
    `AIの答え：「${a.choice}」に揃える`,
}));

import { ProposalPanel } from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "氷の街",
  folderPath: "C:/小説/氷の街",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

function fakeView() {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: { items?: unknown[] }) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

function panelWithView(): ProposalPanel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panel = new ProposalPanel({ resolve: () => undefined } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

/** 「良い ↔ よい」の1件。表記ゆれだけが `notation` を持つ */
function notationIssue() {
  return {
    filePath: "C:/小説/氷の街/本文/003.txt",
    chunkHash: "h1",
    line: 4,
    original: "　良い天気だ。",
    target: "良い",
    suggestion: "よい",
    reason: "「よい」と混在しています",
    confidence: "medium" as const,
    notation: {
      label: "良い ↔ よい",
      forms: [
        { surface: "良い", count: 3, excerpts: ["　良い天気だ。"] },
        { surface: "よい", count: 5, excerpts: ["　よい知らせだ。"] },
      ],
    },
  };
}

/** いま画面に出ている指摘（実体） */
function itemsOf(panel: ProposalPanel): Array<{
  id: string;
  adviceNote?: string;
  askingAdvice?: boolean;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).items;
}

async function pressAsk(panel: ProposalPanel, id: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).handleMessage({ type: "askNotation", id });
}

beforeEach(() => {
  posted.length = 0;
  advice.resolve = undefined;
});

describe("待っている間に一覧が差し替わっても、答えを落とさない", () => {
  test("同じidの、新しい配列のほうへ答えが付く", async () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showResults(work, [notationIssue() as any], "表記ゆれ");
    const id = itemsOf(panel)[0].id;
    const before = itemsOf(panel)[0];

    const pending = pressAsk(panel, id);

    // **待っている間に再チェックが走る。** 同じ検知をもう一度掛けると、
    // まだ手を付けていない指摘は新しい中身で置き換わる
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showResults(work, [notationIssue() as any], "表記ゆれ");
    const after = itemsOf(panel)[0];
    expect(after, "差し替えが起きていない（試験の前提が崩れている）").not.toBe(
      before
    );

    advice.resolve?.({ kind: "advised", advice: { choice: "よい" } });
    await pending;

    expect(itemsOf(panel)[0].id).toBe(id);
    expect(itemsOf(panel)[0].adviceNote).toContain("よい");
    // 押せない印も、いま画面にあるほうで下ろす
    expect(itemsOf(panel)[0].askingAdvice).toBe(false);
  });

  test("訊けなかった理由も、いま画面にある指摘へ書く", async () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showResults(work, [notationIssue() as any], "表記ゆれ");
    const id = itemsOf(panel)[0].id;

    const pending = pressAsk(panel, id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showResults(work, [notationIssue() as any], "表記ゆれ");

    advice.resolve?.({ kind: "failed", reason: "AIが繋がりませんでした" });
    await pending;

    expect(itemsOf(panel)[0].adviceNote).toContain("繋がりません");
  });

  test("作者が断ったときは、何も書かない", async () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showResults(work, [notationIssue() as any], "表記ゆれ");
    const id = itemsOf(panel)[0].id;

    const pending = pressAsk(panel, id);
    advice.resolve?.({ kind: "cancelled" });
    await pending;

    // ダイアログで既に伝わっている。断ったのに失敗したように見せない
    expect(itemsOf(panel)[0].adviceNote).toBeUndefined();
    expect(itemsOf(panel)[0].askingAdvice).toBe(false);
  });
});
