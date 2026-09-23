import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 提案パネルの「適用」→「戻す」の往復（設計書6.8.12）。
 *
 * **実機で見つかった不具合**（2026-09-06）：戻す側は行内で修正案の
 * **最初の一致**を書き換えていたため、同じ行の指摘より前に修正案と同じ語が
 * あると、**関係のない箇所を書き換えていた。** 原稿を壊す種類の不具合なので、
 * 往復して元通りになることを本文の中身で確かめる。
 */

/** 偽の本文。書き込みのたびに置き換わる */
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
      // 書き込んだファイルは開いていない（表示の作り直しは通らない）
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

vi.mock("../../src/core/textFile", () => ({
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

/** 校閲ロックは掛かっていない（ロックの扱いは `proposalAndLock.test.ts`） */
vi.mock("../../src/core/fileLockStore", () => ({
  FileLockStore: class {
    async lockFor(): Promise<undefined> {
      return undefined;
    }
  },
}));

/** 編集履歴（gitの問い合わせを通さない。ここで見たいのは本文の中身） */
const edits: Array<{ action: string; detail?: string }> = [];
vi.mock("../../src/core/actorContext", () => ({
  isEditorMode: () => false,
  manualActor: () => "author",
  recordEdit: vi.fn(async (_work: unknown, entry: { action: string; detail?: string }) => {
    edits.push(entry);
  }),
}));

import { ProposalPanel } from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-06T00:00:00.000Z",
};

/**
 * 同じ行に、修正案と同じ語が**指摘より前**にある本文。
 *
 * 「彼女が走った」は正しく書けている。直すのは後ろの「彼は走つた」だけ
 */
const line = "　彼女が走った。彼は走つた。";
const original = `${line}\n　夜が明けた。\n`;

const typo = {
  filePath: "C:/小説/いじめられっ子/本文/003.txt",
  chunkHash: "h1",
  line: 1,
  original: "彼は走つた。",
  target: "走つた",
  suggestion: "走った",
  reason: "促音の誤り",
  confidence: "high" as const,
};

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

function panelWithItem(): ProposalPanel {
  const panel = new ProposalPanel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  panel.showResults(work, [typo]);
  return panel;
}

function firstId(panel: ProposalPanel): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).items[0].id as string;
}

function firstItem(panel: ProposalPanel): { status: string; statusDetail?: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).items[0];
}

async function press(
  panel: ProposalPanel,
  type: "apply" | "undo"
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type, id: firstId(panel) });
}

beforeEach(() => {
  text = original;
  edits.length = 0;
});

describe("適用してから戻すと、本文が元へ戻る", () => {
  test("同じ行の前に修正案と同じ語があっても、直した箇所だけが戻る", async () => {
    const panel = panelWithItem();

    await press(panel, "apply");
    expect(text).toBe("　彼女が走った。彼は走った。\n　夜が明けた。\n");

    await press(panel, "undo");

    // **「彼女が走った」を巻き込まない**（実機で壊れていた形）
    expect(text).toBe(original);
    expect(firstItem(panel).status).toBe("pending");
  });

  test("戻したあと、もう一度適用できる", async () => {
    const panel = panelWithItem();

    await press(panel, "apply");
    await press(panel, "undo");
    await press(panel, "apply");

    expect(text).toBe("　彼女が走った。彼は走った。\n　夜が明けた。\n");
    expect(firstItem(panel).status).toBe("applied");
  });

  test("適用のあと作者が手で書き直していれば、戻さない", async () => {
    const panel = panelWithItem();

    await press(panel, "apply");
    text = "　彼女が駆けた。彼は駆け出した。\n　夜が明けた。\n";

    await press(panel, "undo");

    expect(text).toBe("　彼女が駆けた。彼は駆け出した。\n　夜が明けた。\n");
    expect(firstItem(panel).status).toBe("applied");
    expect(firstItem(panel).statusDetail).toContain("戻せませんでした");
  });
});
