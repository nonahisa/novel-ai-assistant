import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 編集者モードでは本文を書き換えない（設計書5.6の柱）。
 *
 * `applyIssue` は `isEditorMode()` が真なら `proposeIssue` へ回し、
 * 本文には触らず提案の台帳（`.aiwriter/proposals/proposals.jsonl`）へ
 * 積むだけの作りになっている。ところが `isEditorMode` を差し替えている
 * 既存テストは全部 `() => false`（作者モード）で固定されており、
 * `() => true`（編集者モード）を通す既存テストが無かった。
 *
 * **編集部は本文を書き換えず、提案として置く**——この柱が崩れていないかを
 * 直に確かめる。作者モード側（書き込みが起きること）は
 * `proposalPanelUndo.test.ts` などが既に見ている。
 */

/** 偽の本文。書き込みが起きればここが変わるはずだが、編集者モードでは変わらない */
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

// **本文の書き込みは `writeTextFilePreservingFormat` だけを通る**（規則1）。
// 編集者モードでは1回も呼ばれないことを、このモックで確かめる
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

vi.mock("../../src/core/fileLockStore", () => ({
  FileLockStore: class {
    async lockFor(): Promise<undefined> {
      return undefined;
    }
  },
}));

/** 編集履歴。ここでは「誰が」「何を」提案したかだけを見る */
const edits: Array<{ actor: string; action: string; detail?: string }> = [];
vi.mock("../../src/core/actorContext", () => ({
  isEditorMode: () => true,
  manualActor: () => "editor",
  recordEdit: vi.fn(
    async (
      _work: unknown,
      entry: { actor: string; action: string; detail?: string }
    ) => {
      edits.push(entry);
    }
  ),
}));

// gitの実行に環境依存させない（記名は固定値でよい）
vi.mock("../../src/core/gitAttribution", () => ({
  tryGitUserName: vi.fn(async () => "編集部"),
}));

import { ProposalPanel } from "../../src/features/proposalPanel";
import { writeTextFilePreservingFormat } from "../../src/core/textFile";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-06T00:00:00.000Z",
};

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

async function press(panel: ProposalPanel, type: "apply"): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type, id: firstId(panel) });
}

beforeEach(() => {
  text = original;
  files.clear();
  edits.length = 0;
  vi.mocked(writeTextFilePreservingFormat).mockClear();
});

describe("編集者モードでは本文を書き換えず、提案として置く（設計書5.6）", () => {
  test("『適用』を押しても本文は変わらず、台帳へ提案が積まれる", async () => {
    const panel = panelWithItem();

    await press(panel, "apply");

    // **本文への書き込みが1回も呼ばれない。** 編集部は本文を触らない
    expect(writeTextFilePreservingFormat).not.toHaveBeenCalled();
    expect(text).toBe(original);

    // 提案の台帳（proposals.jsonl）へ積まれている
    const written = [...files.entries()].find(([path]) =>
      path.endsWith("proposals.jsonl")
    );
    expect(written).toBeDefined();
    const [, bytes] = written!;
    const saved = new TextDecoder().decode(bytes);
    expect(saved).toContain('"kind":"proposal"');
    expect(saved).toContain(typo.suggestion);

    // 画面上も「適用済み」ではなく「提案として送った」旨になる
    expect(firstItem(panel).status).toBe("applied");
    expect(firstItem(panel).statusDetail).toBe("提案として作者へ送りました。");

    // 編集履歴には「提案した」が残る（本文を「反映した」とは書かない）
    expect(edits).toHaveLength(1);
    expect(edits[0].actor).toBe("editor");
    expect(edits[0].action).toContain("提案した");
  });
});
