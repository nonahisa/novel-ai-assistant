import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 編集部の提案まわりで編集履歴へ残す `file` は、**作品フォルダーからの相対パス**
 * （`core/editHistoryFormat.ts` の定義）。
 *
 * 提案した／採った／読んだ／見送ったの記録が、ファイル名だけ（`basename`）を
 * 書いていた。タイムラインの欄は編集履歴を `file` で照らすので、
 * **別の章のフォルダーにある同じ名前の話**（`第1章/episode_0001.md` と
 * `第2章/episode_0001.md`）の記録が、両方の話に出てしまう。
 */

let text = "";
let editorMode = false;
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

const edits: Array<{ actor: string; action: string; file: string }> = [];
vi.mock("../../../src/core/actorContext", () => ({
  isEditorMode: () => editorMode,
  manualActor: () => (editorMode ? "editor" : "author"),
  recordEdit: vi.fn(
    async (_work: unknown, entry: { actor: string; action: string; file: string }) => {
      edits.push(entry);
    }
  ),
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

/** 章のフォルダーの中の話。名前だけでは、ほかの章の同じ名前の話と見分けられない */
const RELATIVE = "本文/第1章/episode_0001.md";

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

function newPanel(): ProposalPanel {
  const panel = new ProposalPanel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

function proposal(overrides: Partial<Proposal>): Proposal {
  return {
    id: "p-test",
    time: "2026-11-01T00:00:00.000Z",
    proposer: "編集者",
    file: RELATIVE,
    line: 1,
    original: "走つた",
    target: "走つた",
    suggestion: "走った",
    reason: "促音",
    category: HAND_EDIT_CATEGORY,
    ...overrides,
  };
}

/** 台帳に置いた提案を、編集部の提案を見るときと同じ形でパネルへ並べる */
async function panelWithProposal(entry: Proposal): Promise<ProposalPanel> {
  await new ProposalStore(work).propose([entry]);
  const [view] = await new ProposalStore(work).load();
  const panel = newPanel();
  panel.showProposals(work, [
    {
      id: `proposal:${view.id}`,
      proposalId: view.id,
      filePath: view.file,
      fileName: "episode_0001.md",
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

async function press(panel: ProposalPanel, type: "apply" | "dismiss"): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (panel as any).items[0].id as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type, id });
}

function recorded(action: string): string | undefined {
  return edits.find((entry) => entry.action.includes(action))?.file;
}

beforeEach(() => {
  text = body;
  editorMode = false;
  files.clear();
  edits.length = 0;
});

describe("編集部の提案の編集履歴は、作品からの相対パスで残す", () => {
  test("編集者が提案した記録", async () => {
    editorMode = true;
    const panel = newPanel();
    panel.showResults(work, [
      {
        filePath: `${work.folderPath}/${RELATIVE}`,
        chunkHash: "h1",
        line: 1,
        original: "彼は走つた。",
        target: "走つた",
        suggestion: "走った",
        reason: "促音の誤り",
        confidence: "high",
      },
    ]);

    await press(panel, "apply");

    expect(recorded("提案した")).toBe(RELATIVE);
  });

  test("作者が採り入れた記録", async () => {
    const panel = await panelWithProposal(proposal({}));

    await press(panel, "apply");

    expect(recorded("採り入れた")).toBe(RELATIVE);
  });

  test("作者が意見を読んだ記録", async () => {
    const panel = await panelWithProposal(
      proposal({
        id: "p-memo",
        line: 2,
        original: "　夜が明けた。",
        target: "　夜が明けた。",
        suggestion: "",
        reason: "情景をもう少し",
        category: HAND_MEMO_CATEGORY,
      })
    );

    await press(panel, "apply");

    expect(recorded("読んだ")).toBe(RELATIVE);
  });

  test("作者が見送った記録", async () => {
    const panel = await panelWithProposal(proposal({ id: "p-reject" }));

    await press(panel, "dismiss");

    expect(recorded("見送った")).toBe(RELATIVE);
  });
});
