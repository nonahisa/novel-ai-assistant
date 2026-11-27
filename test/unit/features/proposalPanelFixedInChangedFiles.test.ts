import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 本文で直された指摘の照らし直しを、知らせに乗って届いたファイルに絞る
 * （動作の高速化、2026-11-27。設計書6.96.5）。
 *
 * 1話を保存するたびに、指摘のある全話を読み直していた。絞っても**外す・残すの判断は
 * 今と1件も変えない**——そのために、次の場面でも今と同じ結果になることを見張る。
 *
 * - 一度も照らせていない行は、別のファイルの知らせでも照らす（検知の結果を出したあと、
 *   最初の知らせが別の話だった）
 * - 照らしている最中に届いた別のファイルの知らせを取りこぼさない
 * - 読めなかったファイルの行は、次の知らせ（別のファイル）で照らし直す
 * - 見送っていたあいだに本文が変わった行は、戻したあとの知らせで照らす
 * - 道の無い知らせ・URI の道を含む知らせは、今までどおり全部を照らす
 *
 * ファイルごとの読み込みの回数は、絞れたことの確かめ（最後の describe）。
 */

/** 偽のディスク（道 → 本文） */
const disk = new Map<string, string>();
/** 読み込みを失敗させる道 */
const failing = new Set<string>();
/** 読んだ道（順に） */
const reads: string[] = [];
/** 読み込みを止めておく（照らしの途中に知らせを割り込ませるため） */
let gate: Promise<void> | undefined;

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
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      textDocuments: [],
      fs: {
        readFile: vi.fn(async () => {
          throw new Error("FileNotFound");
        }),
        writeFile: vi.fn(async () => undefined),
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
  readTextFile: vi.fn(async (filePath: string) => {
    reads.push(filePath);
    if (gate) await gate;
    if (failing.has(filePath)) throw new Error("EBUSY");
    const text = disk.get(filePath);
    if (text === undefined) throw new Error("FileNotFound");
    return { text, hash: "h", encoding: "utf8", eol: "\n", bom: false };
  }),
  sameFilePath: () => false,
  writeTextFilePreservingFormat: vi.fn(async () => ({ ok: true })),
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

import { ProposalPanel } from "../../../src/features/proposalPanel";
import type { ProposalViewItem } from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w-changed",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-19T00:00:00.000Z",
};

const FILE_A = "C:/小説/いじめられっ子/本文/001.txt";
const FILE_B = "C:/小説/いじめられっ子/本文/002.txt";
const TEXT_A = "　彼は走つた。\n　空が青い。\n";
const TEXT_B = "　夜が開けた。\n　鳥が鳴く。\n";

const typos = [
  {
    filePath: FILE_A,
    chunkHash: "a1",
    line: 1,
    original: "　彼は走つた。",
    target: "走つた",
    suggestion: "走った",
    reason: "促音の誤り",
    confidence: "high" as const,
  },
  {
    filePath: FILE_B,
    chunkHash: "b1",
    line: 1,
    original: "　夜が開けた。",
    target: "開けた",
    suggestion: "明けた",
    reason: "変換の誤り",
    confidence: "high" as const,
  },
];

function newPanel(): ProposalPanel {
  const panel = new ProposalPanel();
  panel.resolveWebviewView({
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: () => Promise.resolve(true),
    },
    onDidDispose: () => ({ dispose: () => undefined }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return panel;
}

function statuses(panel: ProposalPanel): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((panel as any).items as ProposalViewItem[]).map((item) => item.status);
}

function itemsOf(panel: ProposalPanel): ProposalViewItem[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).items as ProposalViewItem[];
}

beforeEach(() => {
  disk.clear();
  disk.set(FILE_A, TEXT_A);
  disk.set(FILE_B, TEXT_B);
  failing.clear();
  reads.length = 0;
  gate = undefined;
});

describe("知らせのファイルに絞っても、外す・残すは今と同じ", () => {
  test("知らせの届いたファイルで直された指摘が外れ、ほかの話の指摘は残る", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    disk.set(FILE_A, "　彼は走った。\n　空が青い。\n");
    await panel.noteManuscriptEdited(work, [FILE_A]);

    expect(statuses(panel)).toEqual(["resolved", "pending"]);
    expect(panel.remainingIn(work, "誤字脱字")).toBe(1);
  });

  test("まだ一度も照らせていない行は、別のファイルの知らせでも照らす", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    // 検知のあとに B が直されていたが、最初に届いた知らせは A のもの
    disk.set(FILE_B, "　夜が明けた。\n　鳥が鳴く。\n");
    await panel.noteManuscriptEdited(work, [FILE_A]);

    expect(statuses(panel)).toEqual(["pending", "resolved"]);
  });

  test("照らしている最中に届いた別のファイルの知らせを取りこぼさない", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);
    // 一度照らし終えて、どちらの行も「照らし済み」にしておく
    await panel.noteManuscriptEdited(work);
    expect(statuses(panel)).toEqual(["pending", "pending"]);

    let open: () => void = () => undefined;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = panel.noteManuscriptEdited(work, [FILE_A]);
    // A を読んでいる最中に、B が直されて B の知らせが届く
    await Promise.resolve();
    disk.set(FILE_B, "　夜が明けた。\n　鳥が鳴く。\n");
    const second = panel.noteManuscriptEdited(work, [FILE_B]);
    gate = undefined;
    open();
    await Promise.all([first, second]);

    expect(statuses(panel)).toEqual(["pending", "resolved"]);
  });

  test("読めなかったファイルの行は、次の知らせ（別のファイル）で照らし直す", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    disk.set(FILE_A, "　彼は走った。\n　空が青い。\n");
    failing.add(FILE_A);
    await panel.noteManuscriptEdited(work, [FILE_A]);
    expect(statuses(panel)).toEqual(["pending", "pending"]);

    failing.clear();
    await panel.noteManuscriptEdited(work, [FILE_B]);
    expect(statuses(panel)).toEqual(["resolved", "pending"]);
  });

  test("空に見えた本文の行も、次の知らせで照らし直す", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    disk.set(FILE_A, "");
    await panel.noteManuscriptEdited(work, [FILE_A]);
    expect(statuses(panel)).toEqual(["pending", "pending"]);

    disk.set(FILE_A, "　彼は走った。\n　空が青い。\n");
    await panel.noteManuscriptEdited(work, [FILE_B]);
    expect(statuses(panel)).toEqual(["resolved", "pending"]);
  });

  test("見送っていたあいだに本文が変わった行は、戻したあとの知らせで照らす", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);
    await panel.noteManuscriptEdited(work);

    const [rowA] = itemsOf(panel);
    rowA.status = "dismissed";
    disk.set(FILE_A, "　彼は走った。\n　空が青い。\n");
    await panel.noteManuscriptEdited(work, [FILE_A]);
    expect(rowA.status).toBe("dismissed");

    // 見送りを戻した（画面の［戻す］の代わりに状態だけ戻す）。次の知らせは B のもの
    rowA.status = "pending";
    await panel.noteManuscriptEdited(work, [FILE_B]);
    expect(rowA.status).toBe("resolved");
  });

  test("道の無い知らせでは、今までどおり全部を照らす", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);
    await panel.noteManuscriptEdited(work);

    disk.set(FILE_A, "　彼は走った。\n　空が青い。\n");
    disk.set(FILE_B, "　夜が明けた。\n　鳥が鳴く。\n");
    await panel.noteManuscriptEdited(work);

    expect(statuses(panel)).toEqual(["resolved", "resolved"]);
  });

  test("外したあとに元へ戻したら、そのファイルの知らせで一覧へ戻る", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    disk.set(FILE_A, "　彼は走った。\n　空が青い。\n");
    await panel.noteManuscriptEdited(work, [FILE_A]);
    expect(statuses(panel)).toEqual(["resolved", "pending"]);

    disk.set(FILE_A, TEXT_A);
    await panel.noteManuscriptEdited(work, [FILE_A]);
    expect(statuses(panel)).toEqual(["pending", "pending"]);
  });
});

describe("照らし終えた後、知らせの来ないファイルは読み直さない", () => {
  test("B の知らせでは、照らし済みの A を読まない", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);
    await panel.noteManuscriptEdited(work);

    reads.length = 0;
    await panel.noteManuscriptEdited(work, [FILE_B]);
    expect(reads).toEqual([FILE_B]);
  });

  test("URI の道を含む知らせは、作品ぜんたいの知らせとして全部を読む", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);
    await panel.noteManuscriptEdited(work);

    reads.length = 0;
    await panel.noteManuscriptEdited(work, ["vscode-vfs://github/owner/repo/本文/002.txt"]);
    expect([...reads].sort()).toEqual([FILE_A, FILE_B]);
  });
});
