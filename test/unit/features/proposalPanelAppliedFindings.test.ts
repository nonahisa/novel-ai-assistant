import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 提案パネルの「当てたもの」（作者の裁定 2026-10-04。設計書6.96.5・6.115）。
 *
 * 提案パネルは開くときに置き場の未処理しか並べないので、原稿箱の取り込みで当てた
 * ［直す］［自分で直す］・校正・メモパネルの［直す］・閉じる前の［適用］を、あとから
 * パネルの［戻す］で戻す口が無かった。ここでは本物の提案パネルを通して次を見る。
 *
 * - 並ぶ（誰がどこで当てたかつき）・期限で外れる
 * - ［戻す］は既存の［戻す］と同じ道で本文を戻し、置き場に「戻した」を残し、欄から外れる
 * - 本文が変わっていて戻せないときは、何も書かずに理由を出す
 * - 未処理の一覧の件数・中身は変えない。この起動中に一覧で当てた行は二重に出さない
 */

/** 偽の本文。書き込みのたびに置き換わる */
let text = "";
/** 書き込みを断らせるとき（外で書き換えられた、など） */
let refuseWrite = false;
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
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
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
  readTextFile: vi.fn(async () => ({ text, hash: "h", encoding: "utf8", eol: "\n", bom: false })),
  sameFilePath: () => false,
  writeTextFilePreservingFormat: vi.fn(async (_path: string, next: string) => {
    if (refuseWrite) return { ok: false, reason: "modified_externally" };
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

vi.mock("../../../src/features/sceneMemoPanel", () => ({
  refreshSceneMemoFindings: vi.fn(async () => undefined),
}));

import { ProposalPanel, type ProposalViewItem } from "../../../src/features/proposalPanel";
import { applyFindingFromMemo, primeAppliedFindings } from "../../../src/features/primeFindings";
import { FindingStore } from "../../../src/features/findingStore";
import { OUTBOX_DECISION_NOTES, findingId, type Finding } from "../../../src/models/finding";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-10-04T00:00:00.000Z",
};

const FILE = "本文/003.txt";
const FILE_PATH = "C:/小説/いじめられっ子/本文/003.txt";
const ORIGINAL_TEXT = "　彼は走つた。\n　夜が明けた。\n";
const FIXED_TEXT = "　彼は走った。\n　夜が明けた。\n";

/** 置き場の誤字脱字の1件（検知が残した形） */
function typoFinding(): Finding {
  return {
    id: findingId(FILE, "　彼は走つた。", "走つた", "走った", "typo", "誤字脱字"),
    time: new Date().toISOString(),
    file: FILE,
    hintLine: 1,
    original: "　彼は走つた。",
    target: "走つた",
    suggestion: "走った",
    before: "",
    after: "　夜が明けた。",
    message: "促音の誤り",
    category: "typo",
    label: "誤字脱字",
    producer: { providerId: "ollama", model: "gemma4:e4b" },
  };
}

type IssuesMessage = {
  type: string;
  items: Array<{ id: string; status: string }>;
  applied: Array<{
    findingId: string;
    fileName: string;
    line: number;
    target: string;
    suggestion: string;
    appliedBy: string;
    note?: string;
  }>;
  appliedTitle: string;
};

let posted: IssuesMessage[] = [];

function newPanel(): ProposalPanel {
  const panel = new ProposalPanel();
  const view = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: IssuesMessage) => {
        if (message.type === "issues") posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(view as any);
  return panel;
}

function last(): IssuesMessage {
  const message = posted[posted.length - 1];
  if (!message) throw new Error("画面へ何も送られていません");
  return message;
}

/** その分類の行（表示中でなくても、作品の置き場から引く） */
function rowsOf(panel: ProposalPanel, category: string): ProposalViewItem[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = panel as any;
  if (internal.category === category && internal.work) return internal.items as ProposalViewItem[];
  for (const entry of internal.buckets.values()) {
    const bucket = entry.categories.get(category);
    if (bucket) return bucket.items as ProposalViewItem[];
  }
  return [];
}

async function press(panel: ProposalPanel, findingIdToUndo: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type: "undoApplied", findingId: findingIdToUndo });
}

async function decisionsOf(id: string): Promise<Array<{ status: string; note: string }>> {
  const raw = [...files.entries()].find(([name]) => name.endsWith("findings.jsonl"))?.[1];
  if (!raw) return [];
  return new TextDecoder()
    .decode(raw)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string; findingId?: string; status: string; note: string })
    .filter((line) => line.kind === "decision" && line.findingId === id)
    .map((line) => ({ status: line.status, note: line.note }));
}

beforeEach(async () => {
  text = FIXED_TEXT;
  refuseWrite = false;
  files.clear();
  posted = [];
  writes.count = 0;
});

/** 原稿箱の取り込みで［直す］を当てたあとの置き場（本文は直した字） */
async function storeRemoteFix(time = new Date().toISOString()): Promise<Finding> {
  const finding = typoFinding();
  const store = new FindingStore(work);
  await store.record([finding]);
  await store.decide([{ findingId: finding.id, time, status: "accepted", note: OUTBOX_DECISION_NOTES.fix }]);
  return finding;
}

describe("並ぶ", () => {
  test("出先で当てた指摘が、話・行・元の字→当てた字・誰がどこでつきで並ぶ", async () => {
    const finding = await storeRemoteFix();
    const panel = newPanel();

    expect(await primeAppliedFindings(work, panel)).toBe(1);

    expect(last().appliedTitle).toBe("当てたもの（直近3日）");
    expect(last().applied).toEqual([
      {
        findingId: finding.id,
        fileName: "003.txt",
        line: 1,
        target: "走つた",
        suggestion: "走った",
        appliedBy: "出先で当てた",
        note: undefined,
        busy: undefined,
      },
    ]);
  });

  test("未処理の一覧の件数・中身は変えない", async () => {
    await storeRemoteFix();
    const panel = newPanel();
    const before = last();

    await primeAppliedFindings(work, panel);

    expect(last().items).toEqual(before.items);
    expect(panel.remainingIn(work, "誤字脱字")).toBe(0);
    // タブも作品の切り替え口も増えない（未処理の段を作らない）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((panel as any).buckets.size).toBe(0);
  });

  test("当てたのが期限（既定3日）より前なら並ばない", async () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    await storeRemoteFix(fourDaysAgo);
    const panel = newPanel();

    expect(await primeAppliedFindings(work, panel)).toBe(0);
    expect(last().applied).toEqual([]);
  });

  test("当てたあとで作者が書き換えた行は並ばない（戻す先が無い）", async () => {
    await storeRemoteFix();
    text = "　彼は駆けだした。\n　夜が明けた。\n";
    const panel = newPanel();

    expect(await primeAppliedFindings(work, panel)).toBe(0);
  });

  test("［済み］（本文に触れていない）は並ばない", async () => {
    const finding = typoFinding();
    const store = new FindingStore(work);
    await store.record([finding]);
    await store.decide([
      { findingId: finding.id, time: new Date().toISOString(), status: "accepted", note: OUTBOX_DECISION_NOTES.done },
    ]);
    const panel = newPanel();

    expect(await primeAppliedFindings(work, panel)).toBe(0);
  });

  test("この起動中に一覧で当てた行（「適用済み・［戻す］」で出ているもの）は、欄に二重に出さない", async () => {
    text = ORIGINAL_TEXT;
    const finding = typoFinding();
    await new FindingStore(work).record([finding]);
    const panel = newPanel();
    await applyFindingFromMemo(work, panel, { ...finding, line: 1 });
    expect(text).toBe(FIXED_TEXT);

    expect(await primeAppliedFindings(work, panel)).toBe(1);
    expect(last().applied).toEqual([]);
    expect(rowsOf(panel, "誤字脱字")[0].status).toBe("applied");
  });
});

describe("［戻す］", () => {
  test("既存の［戻す］と同じ道で本文が戻り、置き場に「戻した」が残り、欄から外れて一覧に未処理で並ぶ", async () => {
    const finding = await storeRemoteFix();
    const panel = newPanel();
    await primeAppliedFindings(work, panel);

    await press(panel, finding.id);

    expect(text).toBe(ORIGINAL_TEXT);
    expect(writes.count).toBe(1);
    expect(await decisionsOf(finding.id)).toEqual([
      { status: "accepted", note: OUTBOX_DECISION_NOTES.fix },
      { status: "pending", note: "適用を戻した" },
    ]);
    expect(last().applied).toEqual([]);
    // 既存の［戻す］と同じく、もう一度当てられる形で一覧に残る
    const rows = rowsOf(panel, "誤字脱字");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(panel.remainingIn(work, "誤字脱字")).toBe(1);
  });

  test("並べたあとで本文が書き換えられていたら、何も書かずに理由を出す（一覧にも何も増えない）", async () => {
    const finding = await storeRemoteFix();
    const panel = newPanel();
    await primeAppliedFindings(work, panel);
    text = "　彼は駆けだした。\n　夜が明けた。\n";

    await press(panel, finding.id);

    expect(writes.count).toBe(0);
    expect(text).toBe("　彼は駆けだした。\n　夜が明けた。\n");
    expect(await decisionsOf(finding.id)).toHaveLength(1);
    const shown = last().applied;
    expect(shown).toHaveLength(1);
    expect(shown[0].note).toContain("戻せませんでした");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((panel as any).buckets.size).toBe(0);
  });

  test("書き込みが断られたら（外で書き換えられた等）、その理由を出し、置いた行を引き上げる", async () => {
    const finding = await storeRemoteFix();
    const panel = newPanel();
    await primeAppliedFindings(work, panel);
    refuseWrite = true;

    await press(panel, finding.id);

    expect(text).toBe(FIXED_TEXT);
    expect(await decisionsOf(finding.id)).toHaveLength(1);
    expect(last().applied[0].note).toContain("変更されています");
    expect(rowsOf(panel, "誤字脱字")).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((panel as any).buckets.size).toBe(0);
  });

  test("戻せなかったあと、作者が見ていた分類は奪わない", async () => {
    const finding = await storeRemoteFix();
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
    await primeAppliedFindings(work, panel);
    refuseWrite = true;

    await press(panel, finding.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((panel as any).category).toBe("推敲");
    // 置くために作った「誤字脱字」の段は片づく（タブが増えない）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = [...(panel as any).buckets.values()][0];
    expect([...entry.categories.keys()]).toEqual(["推敲"]);
  });

  test("［自分で直す］の組は作者の文の行だけが並び、戻すと原文の一文に戻る", async () => {
    const aiFinding = typoFinding();
    const ownText = "　彼は、走りだした。";
    const authorFinding: Finding = {
      ...aiFinding,
      id: findingId(FILE, aiFinding.original, aiFinding.original, ownText, "typo", "誤字脱字"),
      target: aiFinding.original,
      suggestion: ownText,
      message: OUTBOX_DECISION_NOTES.authorEdit,
      producer: undefined,
    };
    const store = new FindingStore(work);
    await store.record([aiFinding, authorFinding]);
    const now = new Date().toISOString();
    await store.decide([
      { findingId: aiFinding.id, time: now, status: "accepted", note: OUTBOX_DECISION_NOTES.editOriginal },
      { findingId: authorFinding.id, time: now, status: "accepted", note: OUTBOX_DECISION_NOTES.authorEdit },
    ]);
    text = `${ownText}\n　夜が明けた。\n`;
    const panel = newPanel();

    expect(await primeAppliedFindings(work, panel)).toBe(1);
    expect(last().applied[0]).toMatchObject({
      findingId: authorFinding.id,
      appliedBy: "出先で自分で直した",
      suggestion: ownText,
    });

    await press(panel, authorFinding.id);

    expect(text).toBe(ORIGINAL_TEXT);
    expect(await decisionsOf(authorFinding.id)).toEqual([
      { status: "accepted", note: OUTBOX_DECISION_NOTES.authorEdit },
      { status: "pending", note: "適用を戻した" },
    ]);
    expect(last().applied).toEqual([]);
  });

  test("パソコンで当てた記録（覚え書きが空）も、起こし直したあとで戻せる", async () => {
    const finding = typoFinding();
    const store = new FindingStore(work);
    await store.record([finding]);
    await store.decide([{ findingId: finding.id, time: new Date().toISOString(), status: "accepted", note: "" }]);
    // 起こし直したあとの新しいパネル（一覧には何も無い）
    const panel = newPanel();
    await primeAppliedFindings(work, panel);
    expect(last().applied[0].appliedBy).toBe("パソコンで当てた");

    await press(panel, finding.id);

    expect(text).toBe(ORIGINAL_TEXT);
    expect(last().applied).toEqual([]);
  });
});
