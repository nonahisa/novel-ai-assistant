import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 提案パネルで、ある分類の提案を**最後の1件まで決め終えた**ときに合図を出す
 * （作者の判断 2026-11-01）。
 *
 * 人物名の付け替えは、本文の置き換えを提案パネルへ出し、「適用が済んだら
 * 『人物名変更の資料反映』を」と言うだけだった。その入口は知らせのボタンにしか
 * 無く（詳細メニューから外した。2026-09-24 B10①）、知らせが沈むと探せない。
 * 置き換えを決め終えたその場で資料への反映を訊くため、パネルが合図を出す。
 *
 * - 適用でも見送りでも、残りが0になったら1回だけ鳴る
 * - 残りがあるうちは鳴らない
 * - 適用に失敗した提案は「決めた」に数えない（残りのまま）
 */

let text = "";

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn(),
      visibleTextEditors: [],
      createOutputChannel: () => ({
        appendLine: noop,
        show: noop,
        dispose: noop,
      }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: { readFile: vi.fn(), writeFile: vi.fn(), createDirectory: vi.fn() },
      textDocuments: [],
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
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    ViewColumn: { One: 1 },
  };
});

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text,
    hash: "h",
    encoding: "utf8",
    eol: "\n",
    bom: false,
  })),
  sameFilePath: () => false,
  writeTextFilePreservingFormat: vi.fn(async (_path: string, next: string) => {
    text = next;
    return { ok: true };
  }),
}));

vi.mock("../../../src/core/fileLockStore", () => ({
  FileLockStore: class {
    async lockFor(): Promise<undefined> {
      return undefined;
    }
  },
}));

vi.mock("../../../src/core/actorContext", () => ({
  isEditorMode: () => false,
  manualActor: () => "author",
  recordEdit: vi.fn(async () => undefined),
}));

import { ProposalPanel } from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "氷の街",
  folderPath: "C:/小説/氷の街",
  registeredAt: "2026-11-01T00:00:00.000Z",
};

const CATEGORY = "名前の付け替え";

function rename(line: number, original: string) {
  return {
    filePath: "C:/小説/氷の街/本文/001.txt",
    chunkHash: "h1",
    line,
    original,
    target: "太郎",
    suggestion: "次郎",
    reason: "名前の付け替え",
    confidence: "high" as const,
  };
}

function fakeView() {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: () => Promise.resolve(true),
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

let settled: Array<{ work: string; category: string }> = [];

function panelWithTwo(): ProposalPanel {
  text = "太郎が来た。\n太郎が笑った。\n";
  const panel = new ProposalPanel();
  panel.setOnCategorySettled((target, category) => {
    settled.push({ work: target.id, category });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  // 行は1から数える
  panel.showResults(work, [rename(1, "太郎が来た。"), rename(2, "太郎が笑った。")], CATEGORY);
  return panel;
}

function ids(panel: ProposalPanel): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((panel as any).items as Array<{ id: string }>).map((item) => item.id);
}

async function send(panel: ProposalPanel, message: unknown): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).receive(message);
}

beforeEach(() => {
  settled = [];
});

describe("分類の提案を決め終えたら合図する", () => {
  test("1件目を決めただけでは鳴らず、2件目で1回だけ鳴る", async () => {
    const panel = panelWithTwo();
    const [first, second] = ids(panel);

    await send(panel, { type: "apply", id: first });
    expect(settled).toEqual([]);

    await send(panel, { type: "dismiss", id: second });
    expect(settled).toEqual([{ work: "w1", category: CATEGORY }]);
  });

  test("見送りだけで決め終えても鳴る", async () => {
    const panel = panelWithTwo();
    for (const id of ids(panel)) await send(panel, { type: "dismiss", id });
    expect(settled).toEqual([{ work: "w1", category: CATEGORY }]);
  });

  test("まとめて適用で決め終えても鳴る", async () => {
    const vscode = await import("vscode");
    // まとめての確認（モーダル）で［適用する］を押した体にする
    vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(
      (() => Promise.resolve("適用する")) as never
    );
    const panel = panelWithTwo();
    await send(panel, { type: "applyAll", drops: [] });
    expect(settled).toEqual([{ work: "w1", category: CATEGORY }]);
  });

  test("決め終えたあとに一覧を開き直す・選び直すだけでは鳴らない", async () => {
    const panel = panelWithTwo();
    for (const id of ids(panel)) await send(panel, { type: "dismiss", id });
    settled = [];
    await send(panel, { type: "ready" });
    await send(panel, { type: "selectCategory", category: CATEGORY });
    expect(settled).toEqual([]);
  });
});
