import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 編集部の「意見だけ」の提案を、作者が［読んだ］で片づける（設計書5.6.1.1。
 * 作者の指示 2026-11-01）。
 *
 * 直した案が空の提案を、ふつうの提案と同じ道で採ると、空の文字で置き換えて
 * **選んだ所が本文から消える。** 本文が変わらず、採った記録だけが足されることを
 * 確かめる。直した案のある手書きの提案は、これまでどおり本文に当たる。
 */

/** 偽の本文。書き込みが起きればここが変わる */
let text = "";
/** 偽のディスク（`proposals.jsonl` はここに溜まる） */
const files = new Map<string, Uint8Array>();

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn(),
      setStatusBarMessage: vi.fn(() => ({ dispose: noop })),
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

const edits: Array<{ actor: string; action: string }> = [];
vi.mock("../../../src/core/actorContext", () => ({
  isEditorMode: () => false,
  manualActor: () => "author",
  recordEdit: vi.fn(async (_work: unknown, entry: { actor: string; action: string }) => {
    edits.push(entry);
  }),
}));

vi.mock("../../../src/core/gitAttribution", () => ({
  tryGitUserName: vi.fn(async () => "作者"),
}));

// 採否を決め終えたときの送り返し（git）は、ここでは走らせない
vi.mock("../../../src/core/runtime", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  canRunProcesses: () => false,
}));

import { ProposalPanel } from "../../../src/features/proposalPanel";
import { writeTextFilePreservingFormat } from "../../../src/core/textFile";
import { ProposalStore } from "../../../src/core/proposalStore";
import {
  HAND_EDIT_CATEGORY,
  HAND_MEMO_CATEGORY,
  type Proposal,
} from "../../../src/models/proposal";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-06T00:00:00.000Z",
};

const body = "　彼女が走った。彼は走つた。\n　夜が明けた。\n";

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

function proposal(overrides: Partial<Proposal>): Proposal {
  return {
    id: "p-test",
    time: "2026-11-01T00:00:00.000Z",
    proposer: "編集部",
    file: "本文/003.txt",
    line: 2,
    original: "　夜が明けた。",
    target: "　夜が明けた。",
    suggestion: "",
    reason: "この行の情景をもう少し",
    category: HAND_MEMO_CATEGORY,
    ...overrides,
  };
}

async function panelWith(entry: Proposal): Promise<ProposalPanel> {
  await new ProposalStore(work).propose([entry]);
  const [view] = await new ProposalStore(work).load();
  const panel = new ProposalPanel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  panel.showProposals(work, [
    {
      id: `proposal:${view.id}`,
      proposalId: view.id,
      filePath: view.file,
      fileName: "003.txt",
      chunkHash: view.id,
      line: view.line,
      original: view.original,
      target: view.target,
      suggestion: view.suggestion,
      reason: view.reason,
      confidence: "high",
      status: "pending",
    },
  ]);
  return panel;
}

async function press(panel: ProposalPanel): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (panel as any).items[0].id as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type: "apply", id });
}

function firstItem(panel: ProposalPanel): { status: string; statusDetail?: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).items[0];
}

beforeEach(() => {
  text = body;
  files.clear();
  edits.length = 0;
  vi.mocked(writeTextFilePreservingFormat).mockClear();
});

describe("編集部の意見だけの提案を、作者が受け取る", () => {
  test("［読んだ］を押しても本文は変わらず、読んだ記録だけが足される", async () => {
    const panel = await panelWith(proposal({}));

    await press(panel);

    expect(writeTextFilePreservingFormat).not.toHaveBeenCalled();
    expect(text).toBe(body);
    expect(firstItem(panel).status).toBe("applied");
    expect(firstItem(panel).statusDetail).toContain("本文は変えていません");

    // 台帳では「読んだ」になり、未決から外れる（採用には数えない。作者の決定 2026-11-01）
    const [view] = await new ProposalStore(work).load();
    expect(view.status).toBe("read");
    expect(edits.some((entry) => entry.action === "編集部の意見を読んだ")).toBe(true);
  });

  test("直した案のある手書きの提案は、これまでどおり本文に当たる", async () => {
    const panel = await panelWith(
      proposal({
        id: "p-edit",
        line: 1,
        original: "走つた",
        target: "走つた",
        suggestion: "走った",
        reason: "促音",
        category: HAND_EDIT_CATEGORY,
      })
    );

    await press(panel);

    expect(writeTextFilePreservingFormat).toHaveBeenCalledTimes(1);
    expect(text).toBe("　彼女が走った。彼は走った。\n　夜が明けた。\n");
  });
});
