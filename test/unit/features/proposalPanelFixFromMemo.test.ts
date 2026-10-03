import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 校正・メモパネルの［直す］1手で本文が直る（設計書6.96.5。作者の裁定 2026-10-03）。
 *
 * **当てる道は提案パネルの［適用］と同じ関数**（`applyIssue`）。ここでは本物の
 * 提案パネルを通し、次を見る。
 *
 * - 本文が `writeTextFilePreservingFormat` で直り、置き場に「採った」、
 *   `history/ai-verdicts.jsonl` に採った数が残る（［適用］と同じ記録）
 * - 提案パネルの行は「適用済み」になり、残り件数から外れる
 * - 作者が提案パネルで見ていた分類は奪わない
 * - ［戻す］で本文も置き場も戻り、提案パネルの［戻す］で先に戻してあっても壊れない
 * - 修正案の無い指摘（矛盾）は当てない
 */

/** 偽の本文。書き込みのたびに置き換わる */
let text = "";
/** 偽のディスク（`findings.jsonl` と `ai-verdicts.jsonl` はここに溜まる） */
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

const writes = vi.hoisted(() => ({ count: 0 }));
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
    writes.count += 1;
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

/** 校正・メモパネルへ判断が届いたか */
const notified: string[] = [];
vi.mock("../../../src/features/sceneMemoPanel", () => ({
  refreshSceneMemoFindings: vi.fn(async (workId: string) => {
    notified.push(workId);
  }),
}));

import { ProposalPanel, type ProposalViewItem } from "../../../src/features/proposalPanel";
import {
  applyFindingFromMemo,
  undoFindingFromMemo,
} from "../../../src/features/primeFindings";
import { FindingStore, visibleFindings } from "../../../src/features/findingStore";
import { findingId, type Finding } from "../../../src/models/finding";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-10-03T00:00:00.000Z",
};

const FILE = "本文/003.txt";
const FILE_PATH = "C:/小説/いじめられっ子/本文/003.txt";
const original = "　彼は走つた。\n　夜が明けた。\n";

/** 置き場に残っている誤字脱字の1件（校正・メモパネルが並べる形） */
function typoFinding(): Finding & { line: number; filePath: string } {
  return {
    id: findingId(FILE, "　彼は走つた。", "走つた", "走った", "typo", "誤字脱字"),
    time: new Date().toISOString(),
    file: FILE,
    hintLine: 1,
    original: "　彼は走つた。",
    target: "走つた",
    suggestion: "走った",
    before: "",
    after: "",
    message: "促音の誤り",
    category: "typo",
    label: "誤字脱字",
    // 採った数を、出したモデルへ数えるため（6.49.7）
    producer: { providerId: "ollama", model: "gemma4:e4b" },
    line: 1,
    filePath: FILE_PATH,
  };
}

/** 置き場に残っている矛盾の1件（修正案が無い） */
function contradictionFinding(): Finding & { line: number; filePath: string } {
  return {
    id: findingId(FILE, "　夜が明けた。", "", "", "contradiction", "矛盾"),
    time: new Date().toISOString(),
    file: FILE,
    hintLine: 2,
    original: "　夜が明けた。",
    target: "",
    suggestion: "",
    before: "",
    after: "",
    message: "前の話では昼だった",
    category: "contradiction",
    label: "矛盾",
    line: 2,
    filePath: FILE_PATH,
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

function newPanel(): ProposalPanel {
  const panel = new ProposalPanel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

/** その分類の行（表示中でなくても、作品の置き場から引く） */
function rowsOf(panel: ProposalPanel, category: string): ProposalViewItem[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = panel as any;
  if (internal.category === category) return internal.items as ProposalViewItem[];
  for (const entry of internal.buckets.values()) {
    const bucket = entry.categories.get(category);
    if (bucket) return bucket.items as ProposalViewItem[];
  }
  return [];
}

function verdictLines(): Array<{ status: string; model: string }> {
  const saved = [...files.entries()].find(([name]) =>
    name.endsWith("ai-verdicts.jsonl")
  )?.[1];
  if (!saved) return [];
  return new TextDecoder()
    .decode(saved)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { status: string; model: string });
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(async () => {
  text = original;
  files.clear();
  notified.length = 0;
  writes.count = 0;
  // 置き場には、検知が残した指摘が1件ある
  const { line: _line, filePath: _filePath, ...stored } = typoFinding();
  await new FindingStore(work).record([stored]);
});

describe("修正案のある指摘は、［直す］1回で本文へ当たる", () => {
  test("［適用］と同じ道で本文が直り、採否の記録が残る", async () => {
    const panel = newPanel();

    const outcome = await applyFindingFromMemo(work, panel, typoFinding());

    expect(outcome).toEqual({ ok: true });
    expect(text).toBe("　彼は走った。\n　夜が明けた。\n");
    // 書き込みは `writeTextFilePreservingFormat` の1回だけ
    expect(writes.count).toBe(1);
    // 置き場の「採った」——校正・メモパネルからも、あとで開く提案パネルからも消える
    const stored = await new FindingStore(work).load();
    expect(stored[0].status).toBe("accepted");
    expect(visibleFindings(stored, 3)).toHaveLength(0);
    // 採った数（6.49.7）は、出したモデルへ数える
    expect(verdictLines()).toEqual([
      expect.objectContaining({ status: "accepted", model: "gemma4:e4b" }),
    ]);
    // 校正・メモパネルへも知らせる
    expect(notified).toContain(work.id);
  });

  test("提案パネルの行は「適用済み」になり、残り件数から外れる", async () => {
    const panel = newPanel();

    await applyFindingFromMemo(work, panel, typoFinding());

    const rows = rowsOf(panel, "誤字脱字");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("applied");
    expect(panel.remainingIn(work, "誤字脱字")).toBe(0);
  });

  test("同じ指摘が検知の結果として並んでいれば、その行へ当てる（二重にしない）", async () => {
    const panel = newPanel();
    panel.showResults(work, [
      {
        filePath: FILE_PATH,
        chunkHash: "h1",
        line: 1,
        original: "　彼は走つた。",
        target: "走つた",
        suggestion: "走った",
        reason: "促音の誤り",
        confidence: "high",
      },
    ]);
    await settle();

    const outcome = await applyFindingFromMemo(work, panel, typoFinding());

    expect(outcome.ok).toBe(true);
    const rows = rowsOf(panel, "誤字脱字");
    expect(rows).toHaveLength(1);
    expect(rows[0].chunkHash).toBe("h1");
    expect(rows[0].status).toBe("applied");
  });

  test("作者が提案パネルで見ていた分類は奪わない", async () => {
    const panel = newPanel();
    panel.showResults(
      work,
      [
        {
          filePath: FILE_PATH,
          chunkHash: "h2",
          line: 2,
          original: "　夜が明けた。",
          target: "夜が明けた",
          suggestion: "朝になった",
          reason: "言い換え",
          confidence: "medium",
        },
      ],
      "推敲"
    );
    await settle();

    await applyFindingFromMemo(work, panel, typoFinding());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((panel as any).category).toBe("推敲");
    expect(text).toBe("　彼は走った。\n　夜が明けた。\n");
  });
});

describe("［戻す］で元へ戻ると、両方の画面にまた並ぶ", () => {
  test("校正・メモパネルの［戻す］で、本文も置き場も戻る", async () => {
    const panel = newPanel();
    const finding = typoFinding();
    await applyFindingFromMemo(work, panel, finding);

    const outcome = await undoFindingFromMemo(work, panel, finding);

    expect(outcome).toEqual({ ok: true });
    expect(text).toBe(original);
    const stored = await new FindingStore(work).load();
    expect(stored[0].status).toBe("pending");
    // 並べてよいものとして戻る（校正・メモパネルにも、提案パネルにも）
    expect(visibleFindings(stored, 3)).toHaveLength(1);
    expect(rowsOf(panel, "誤字脱字")[0].status).toBe("pending");
    expect(verdictLines().map((line) => line.status)).toEqual([
      "accepted",
      "retracted",
    ]);
  });

  test("提案パネルの［戻す］で先に戻してあれば、何も書かずに「戻っている」と返す", async () => {
    const panel = newPanel();
    const finding = typoFinding();
    await applyFindingFromMemo(work, panel, finding);
    const row = rowsOf(panel, "誤字脱字")[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handleMessage({ type: "undo", id: row.id });
    expect(text).toBe(original);
    const before = writes.count;

    const outcome = await undoFindingFromMemo(work, panel, finding);

    expect(outcome).toEqual({ ok: true });
    expect(writes.count).toBe(before);
    expect(text).toBe(original);
  });
});

describe("修正案の無い指摘は当てない", () => {
  test("矛盾は本文に触らず、当てられないと返す", async () => {
    const panel = newPanel();

    const outcome = await applyFindingFromMemo(work, panel, contradictionFinding());

    expect(outcome.ok).toBe(false);
    expect(writes.count).toBe(0);
    expect(text).toBe(original);
  });
});
