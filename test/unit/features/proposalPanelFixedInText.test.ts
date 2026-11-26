import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作者が本文で直した指摘は、提案パネルから外れる（作者の知らせ 2026-11-27
 * 「誤字脱字を直接書き換えるとパネルから消えない」。設計書6.96.5）。
 *
 * 作品フォルダーの見張り（`WorkFolderWatchers`）が本文の変化を知らせたら、
 * パネルは**まだ手を付けていない**指摘の原文を、いまの本文で照らし直す。
 *
 * - 原文が本文のどこにも無い → 「本文で直された」として一覧から外す（残りの件数も減る）
 * - 上に1行足しただけ（原文は別の行に在る）→ 外さない。行も付け直さない
 * - 外したあとに作者が元へ戻した → 一覧へ戻す
 * - 外したあとに［当てる］が届いても、ずれた所へ書かない（`originalMissing` で止まる）
 */

/** 偽の本文。書き込みのたびに置き換わる */
let text = "";
/** 読み込みを失敗させる（ファイルが消えた・読めない） */
let readFails = false;
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
  readTextFile: vi.fn(async () => {
    if (readFails) throw new Error("EBUSY");
    return { text, hash: "h", encoding: "utf8", eol: "\n", bom: false };
  }),
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

import { ProposalPanel } from "../../../src/features/proposalPanel";
import type { ProposalViewItem } from "../../../src/features/proposalPanel";
import { FindingStore } from "../../../src/features/findingStore";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-19T00:00:00.000Z",
};

const FILE = "C:/小説/いじめられっ子/本文/003.txt";
const ORIGINAL_TEXT = "　彼は走つた。\n　夜が開けた。\n";

const typos = [
  {
    filePath: FILE,
    chunkHash: "h1",
    line: 1,
    original: "　彼は走つた。",
    target: "走つた",
    suggestion: "走った",
    reason: "促音の誤り",
    confidence: "high" as const,
  },
  {
    filePath: FILE,
    chunkHash: "h1",
    line: 2,
    original: "　夜が開けた。",
    target: "開けた",
    suggestion: "明けた",
    reason: "変換の誤り",
    confidence: "high" as const,
  },
];

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
  type: "apply" | "dismiss",
  id: string
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type, id });
}

/** 指摘の記録（待たない作り）が書き終わるまで待つ */
async function settleWrites(): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 作者がエディターで本文を直して保存した（ここでは偽の本文を置き換える） */
function authorEdits(next: string): void {
  text = next;
}

beforeEach(() => {
  text = ORIGINAL_TEXT;
  readFails = false;
  files.clear();
  writeSpy.mockClear();
});

describe("作者が本文で直した指摘は、一覧から外れる", () => {
  test("直した1件だけが外れ、直していない1件は残る。残りの件数も減る", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);
    expect(panel.remainingIn(work, "誤字脱字")).toBe(2);

    authorEdits("　彼は走った。\n　夜が開けた。\n");
    await panel.noteManuscriptEdited(work);

    const [fixed, untouched] = itemsOf(panel);
    expect(fixed.status).toBe("resolved");
    expect(untouched.status).toBe("pending");
    expect(panel.remainingIn(work, "誤字脱字")).toBe(1);
    // **本文には書かない**（実装ルール1。照らし直しは読むだけ）
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("上に1行足しただけでは外さない（原文は別の行に在る）", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    authorEdits("　朝だった。\n" + ORIGINAL_TEXT);
    await panel.noteManuscriptEdited(work);

    expect(itemsOf(panel).map((item) => item.status)).toEqual([
      "pending",
      "pending",
    ]);
    // **行は付け直さない**（AIの出した位置を推し量らない。実装ルール3）
    expect(itemsOf(panel).map((item) => item.line)).toEqual([1, 2]);
    expect(panel.remainingIn(work, "誤字脱字")).toBe(2);
  });

  test("外したあとに作者が元へ戻したら、一覧へ戻る", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    authorEdits("　彼は走った。\n　夜が開けた。\n");
    await panel.noteManuscriptEdited(work);
    expect(panel.remainingIn(work, "誤字脱字")).toBe(1);

    authorEdits(ORIGINAL_TEXT);
    await panel.noteManuscriptEdited(work);

    expect(itemsOf(panel)[0].status).toBe("pending");
    expect(panel.remainingIn(work, "誤字脱字")).toBe(2);
  });

  test("空に見える本文（保存の途中）では照らさない", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    authorEdits("");
    await panel.noteManuscriptEdited(work);

    expect(panel.remainingIn(work, "誤字脱字")).toBe(2);
  });

  test("競合マーカーを含む本文では照らさない", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    authorEdits("<<<<<<< HEAD\n　彼は走った。\n=======\n　彼は走りました。\n>>>>>>> other\n");
    await panel.noteManuscriptEdited(work);

    expect(panel.remainingIn(work, "誤字脱字")).toBe(2);
  });

  test("読み込みが落ちても止まらず、指摘は残る", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    readFails = true;
    await expect(panel.noteManuscriptEdited(work)).resolves.toBeUndefined();

    expect(panel.remainingIn(work, "誤字脱字")).toBe(2);
  });

  test("見送った指摘は、本文で直されても見送りのまま（作者の判断と混ぜない）", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);
    await settleWrites();
    await press(panel, "dismiss", itemsOf(panel)[0].id);

    authorEdits("　彼は走った。\n　夜が開けた。\n");
    await panel.noteManuscriptEdited(work);

    expect(itemsOf(panel)[0].status).toBe("dismissed");
  });

  test("置き場（findings.jsonl）へ判断の行を足さない", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);
    await settleWrites();
    const before = await new FindingStore(work).load();

    authorEdits("　彼は走った。\n　夜が開けた。\n");
    await panel.noteManuscriptEdited(work);
    await settleWrites();

    const after = await new FindingStore(work).load();
    expect(after.map((finding) => finding.status)).toEqual(
      before.map((finding) => finding.status)
    );
    expect(after.every((finding) => (finding.decisions ?? []).length === 0)).toBe(true);
  });

  test("別の分類を見ている間でも、その作品の誤字脱字の件数が減る", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);
    panel.showResults(
      work,
      [
        {
          filePath: FILE,
          chunkHash: "h1",
          line: 2,
          original: "　夜が開けた。",
          target: "夜が",
          suggestion: "夜は",
          reason: "冗長",
          confidence: "medium" as const,
        },
      ],
      "推敲"
    );

    authorEdits("　彼は走った。\n　夜が開けた。\n");
    await panel.noteManuscriptEdited(work);

    expect(panel.remainingIn(work, "誤字脱字")).toBe(1);
    expect(panel.remainingIn(work, "推敲")).toBe(1);
  });
});

describe("直したあとに［当てる］が届いても、ずれた所へ書かない", () => {
  test("外した指摘へ［当てる］が届いても、本文へ書かない", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    authorEdits("　彼は走った。\n　夜が開けた。\n");
    await panel.noteManuscriptEdited(work);
    await press(panel, "apply", itemsOf(panel)[0].id);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(text).toBe("　彼は走った。\n　夜が開けた。\n");

    // ［適用］の道が「当て損ね」に戻しても、次の知らせでまた外れる（赤い行のまま残らない）
    await panel.noteManuscriptEdited(work);
    expect(itemsOf(panel)[0].status).toBe("resolved");
    expect(panel.remainingIn(work, "誤字脱字")).toBe(1);
  });

  test("行がずれて残った指摘の［当てる］は originalMissing で止まる", async () => {
    const panel = newPanel();
    panel.showResults(work, typos);

    authorEdits("　朝だった。\n" + ORIGINAL_TEXT);
    await panel.noteManuscriptEdited(work);
    await press(panel, "apply", itemsOf(panel)[0].id);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(itemsOf(panel)[0].status).toBe("failed");
    expect(itemsOf(panel)[0].statusDetail).toContain("本文が変更されている");
  });
});
