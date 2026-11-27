import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 同じ文に指摘が2つ（AとB）あるとき、パネルの［適用］でAを当てても、Bは
 * 一覧から消えない（1.0.57 の「本文で直した指摘を外す」の続き。設計書6.96.5）。
 *
 * Aを当てると、Bの「元の句」（同じ文）がAの直しで変わり、本文のどこにも
 * 無くなる。見張りの照らし直しは、それを「作者が本文で直した」と読んで
 * Bを外していた——Bの誤字は本文に残ったまま。
 *
 * 作者の答え：「Aの直しを写して、当て直せる形にする」
 * - Bの元の句を、Aを当てた後の本文に合わせて写し直す（押せばそのまま当たる）
 * - 写し直せないときは、Bを残して、押すと「位置を特定できません」と出る形に倒す
 * - 作者が手で本文を直したときの動き（外す）は変えない
 */

/** 偽の本文。書き込みのたびに置き換わる */
let text = "";
const files = new Map<string, Uint8Array>();

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn(async () => undefined) },
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
      textDocuments: [],
      fs: {
        readFile: vi.fn(async (uri: { fsPath: string }) => {
          const bytes = files.get(uri.fsPath);
          if (!bytes) throw new Error("FileNotFound");
          return bytes;
        }),
        writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
          files.set(uri.fsPath, bytes);
        }),
        createDirectory: vi.fn(async () => undefined),
      },
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

const writeSpy = vi.fn(async (_path: string, next: string) => {
  text = next;
  return { ok: true };
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
  writeTextFilePreservingFormat: (path: string, next: string) =>
    writeSpy(path, next),
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

vi.mock("../../../src/features/sceneMemoPanel", () => ({
  refreshSceneMemoFindings: vi.fn(async () => undefined),
}));

import * as vscode from "vscode";
import { ProposalPanel } from "../../../src/features/proposalPanel";
import type { ProposalViewItem } from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-19T00:00:00.000Z",
};

const FILE = "C:/小説/いじめられっ子/本文/003.txt";
const SENTENCE = "　彼は走つて家え帰った。";
const ORIGINAL_TEXT = `${SENTENCE}\n　夜が明けた。\n`;

function typo(target: string, suggestion: string) {
  return {
    filePath: FILE,
    chunkHash: "h1",
    line: 1,
    original: SENTENCE,
    target,
    suggestion,
    reason: "誤字",
    confidence: "high" as const,
  };
}

/** 重ならない2件（A：走つて→走って、B：家え→家へ） */
const separate = [typo("走つて", "走って"), typo("家え", "家へ")];

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

function newPanel(): ProposalPanel {
  const panel = new ProposalPanel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

function itemsOf(panel: ProposalPanel): ProposalViewItem[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).items as ProposalViewItem[];
}

async function press(
  panel: ProposalPanel,
  type: "apply" | "undo" | "applyAll",
  id?: string
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage(id === undefined ? { type } : { type, id });
}

beforeEach(() => {
  text = ORIGINAL_TEXT;
  files.clear();
  writeSpy.mockClear();
  vi.mocked(vscode.window.showWarningMessage).mockReset();
  vi.mocked(vscode.window.showWarningMessage).mockImplementation(() =>
    Promise.resolve(undefined)
  );
});

describe("［適用］でAを当てても、同じ文のBは一覧に残る", () => {
  test("Bは消えず、元の句がAを当てた後の文に写し直され、押せばそのまま当たる", async () => {
    const panel = newPanel();
    panel.showResults(work, separate);
    const [a, b] = itemsOf(panel);

    await press(panel, "apply", a.id);
    expect(text).toBe("　彼は走って家え帰った。\n　夜が明けた。\n");
    // 見張りが本文の変化を知らせる（実機では保存の 500ms 後に届く）
    await panel.noteManuscriptEdited(work);

    expect(b.status).toBe("pending");
    expect(b.original).toBe("　彼は走って家え帰った。");
    expect(panel.remainingIn(work, "誤字脱字")).toBe(1);

    await press(panel, "apply", b.id);
    expect(b.status).toBe("applied");
    expect(text).toBe("　彼は走って家へ帰った。\n　夜が明けた。\n");
  });

  test("Bの直す語がAの直しで壊れたときも、Bは残り、押すと位置を特定できないと出る", async () => {
    const panel = newPanel();
    // A：家え帰→家へ帰、B：え帰→へ帰（直す語が重なる）
    panel.showResults(work, [typo("家え帰", "家へ帰"), typo("え帰", "へ帰")]);
    const [a, b] = itemsOf(panel);

    await press(panel, "apply", a.id);
    await panel.noteManuscriptEdited(work);

    // **黙って消さない**
    expect(b.status).toBe("pending");
    expect(panel.remainingIn(work, "誤字脱字")).toBe(1);

    const before = text;
    await press(panel, "apply", b.id);
    expect(b.status).toBe("failed");
    expect(b.statusDetail).toContain("位置を特定できませんでした");
    expect(text).toBe(before);

    // 赤い行のまま、次の知らせでも外れない
    await panel.noteManuscriptEdited(work);
    expect(b.status).toBe("failed");
  });

  test("Aを戻すと、Bの元の句も戻した後の文に写し直され、一覧に残る", async () => {
    const panel = newPanel();
    panel.showResults(work, separate);
    const [a, b] = itemsOf(panel);

    await press(panel, "apply", a.id);
    await panel.noteManuscriptEdited(work);
    await press(panel, "undo", a.id);
    expect(text).toBe(ORIGINAL_TEXT);
    await panel.noteManuscriptEdited(work);

    expect(a.status).toBe("pending");
    expect(b.status).toBe("pending");
    expect(b.original).toBe(SENTENCE);
    expect(panel.remainingIn(work, "誤字脱字")).toBe(2);
  });

  test("まとめて適用でも、同じ文の2件がどちらも当たる", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => Promise.resolve("適用する")) as any
    );
    const panel = newPanel();
    panel.showResults(work, separate);

    await press(panel, "applyAll");

    expect(itemsOf(panel).map((item) => item.status)).toEqual(["applied", "applied"]);
    expect(text).toBe("　彼は走って家へ帰った。\n　夜が明けた。\n");
  });
});

describe("作者が手で本文を直したときの動きは変えない", () => {
  test("手でAの所を直すと、同じ文のBも今までどおり外れる", async () => {
    const panel = newPanel();
    panel.showResults(work, separate);

    text = "　彼は走って家え帰った。\n　夜が明けた。\n";
    await panel.noteManuscriptEdited(work);

    expect(itemsOf(panel).map((item) => item.status)).toEqual(["resolved", "resolved"]);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
