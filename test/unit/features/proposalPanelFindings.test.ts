import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 提案パネルと、数日残す置き場のあいだ（設計書6.96.4・6.96.5）。
 *
 * 0.68.2 の仕上げで残っていた3つを、実際のパネルを通して見る。
 *
 * 1. **戻した指摘と、もう一度検知した指摘が二重に並ぶ**（番号の作り方が違う）
 * 2. **「戻す」を押しても、採った記録が残ったまま**（判断が2値だった）
 * 3. **判断してもシーンメモの横が古いまま**（知らせる口が無かった）
 */

/** 偽の本文。書き込みのたびに置き換わる */
let text = "";
/** 偽のディスク（`findings.jsonl` はここに溜まる） */
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

/** シーンメモの横の一覧へ、判断が届いたか */
const notified: string[] = [];
vi.mock("../../../src/features/sceneMemoPanel", () => ({
  refreshSceneMemoFindings: vi.fn(async (workId: string) => {
    notified.push(workId);
  }),
}));

import { ProposalPanel } from "../../../src/features/proposalPanel";
import { FindingStore, visibleFindings } from "../../../src/features/findingStore";
import { findingIdOf } from "../../../src/core/findingSource";
import type { ProposalViewItem } from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-19T00:00:00.000Z",
};

const FILE = "C:/小説/いじめられっ子/本文/003.txt";
const original = "　彼は走つた。\n　夜が明けた。\n";

/** 検知が出す1件（番号は `チャンク:行:並び` で組まれる） */
const typo = {
  filePath: FILE,
  chunkHash: "h1",
  line: 1,
  original: "　彼は走つた。",
  target: "走つた",
  suggestion: "走った",
  reason: "促音の誤り",
  confidence: "high" as const,
};

/** 置き場から戻ってきた1件（番号は中身から作った `f…`） */
function restoredItem(): ProposalViewItem {
  const id = findingIdOf(work.folderPath, {
    filePath: FILE,
    line: 1,
    original: typo.original,
    target: typo.target,
    suggestion: typo.suggestion,
    message: "誤字脱字",
    category: "typo",
    label: "誤字脱字",
  });
  return {
    id,
    filePath: FILE,
    fileName: "003.txt",
    chunkHash: "",
    line: 1,
    original: typo.original,
    target: typo.target,
    suggestion: typo.suggestion,
    reason: "誤字脱字",
    detail: "促音の誤り",
    confidence: "medium",
    status: "pending",
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

function itemsOf(panel: ProposalPanel): ProposalViewItem[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).items as ProposalViewItem[];
}

async function press(
  panel: ProposalPanel,
  type: "apply" | "undo",
  id: string
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type, id });
}

/**
 * 記録が書き終わるのを待つ。
 *
 * **指摘の記録は待たない作りである**（`replaceContents` が `void` で
 * 呼ぶ。作者が見ている表示を、ディスクの読み書きで止めないため）。
 * 実機では検知からの間があくが、試験では同じ回で続きを押すので、
 * ここで追いつかせる。
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  text = original;
  files.clear();
  notified.length = 0;
});

describe("戻した指摘と、もう一度検知した指摘が二重に並ばない", () => {
  test("戻したあとに検知すると、検知したてのほうだけが残る", async () => {
    const panel = newPanel();
    panel.showRestoredFindings(work, "誤字脱字", { items: [restoredItem()] });

    panel.showResults(work, [typo]);

    const items = itemsOf(panel);
    expect(items).toHaveLength(1);
    // **チャンクのハッシュを持つほうが残る**（再チェックへ渡せる）
    expect(items[0].chunkHash).toBe("h1");
  });

  test("検知したあとに置き場から戻しても、二重にならない", () => {
    const panel = newPanel();
    panel.showResults(work, [typo]);

    panel.showRestoredFindings(work, "誤字脱字", { items: [restoredItem()] });

    const items = itemsOf(panel);
    expect(items).toHaveLength(1);
    expect(items[0].chunkHash).toBe("h1");
  });

  test("完了通知の件数も、畳んだあとの数になる", () => {
    const panel = newPanel();
    panel.showRestoredFindings(work, "誤字脱字", { items: [restoredItem()] });

    const count = panel.showResults(work, [typo]);

    expect(count.remaining).toBe(1);
  });
});

describe("適用を戻すと、置き場の「採った」も取り消される", () => {
  test("戻したあと、その指摘がまた一覧に並ぶ状態へ返る", async () => {
    const panel = newPanel();
    panel.showResults(work, [typo]);
    await settle();
    const id = itemsOf(panel)[0].id;

    await press(panel, "apply", id);
    const applied = await new FindingStore(work).load();
    expect(applied[0].status).toBe("accepted");

    await press(panel, "undo", id);

    const after = await new FindingStore(work).load();
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("pending");
    // **並べてよいものとして戻ってくる**（隠れたままにならない）
    expect(visibleFindings(after, 3)).toHaveLength(1);
  });

  test("指摘そのものの行は書き換えず、打ち消す行を足す", async () => {
    const panel = newPanel();
    panel.showResults(work, [typo]);
    await settle();
    const id = itemsOf(panel)[0].id;

    await press(panel, "apply", id);
    await press(panel, "undo", id);

    // 置き場の道の組み立ては `workPaths` が決める。**写しを置かない**
    const saved = [...files.entries()].find(([name]) =>
      name.endsWith("findings.jsonl")
    )?.[1];
    expect(saved).toBeDefined();
    const lines = new TextDecoder()
      .decode(saved ?? new Uint8Array())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; status?: string });

    expect(lines.map((line) => line.kind)).toEqual([
      "finding",
      "decision",
      "decision",
    ]);
    expect(lines[1].status).toBe("accepted");
    expect(lines[2].status).toBe("pending");
  });
});

describe("判断は、シーンメモの横にも届く", () => {
  test("適用すると、開いているシーンメモへ知らせる", async () => {
    const panel = newPanel();
    panel.showResults(work, [typo]);
    await settle();

    await press(panel, "apply", itemsOf(panel)[0].id);

    expect(notified).toContain(work.id);
  });

  /**
   * 逆向き——シーンメモで見送ったものを、この一覧からも下げる。
   *
   * **画面の番号は検知が付けた `チャンク:行:並び`** で、置き場の番号
   * （`f…`）とは別物である。見分けは置き場の番号でする。
   */
  test("シーンメモで見送ると、提案の一覧からも下がる", () => {
    const panel = newPanel();
    panel.showResults(work, [typo]);
    const findingId = restoredItem().id;

    panel.noteFindingDismissed(work, findingId);

    expect(itemsOf(panel)[0].status).toBe("dismissed");
  });

  test("別の指摘は巻き添えにしない", () => {
    const panel = newPanel();
    panel.showResults(work, [typo]);

    panel.noteFindingDismissed(work, "f-まったく別のもの");

    expect(itemsOf(panel)[0].status).toBe("pending");
  });
});
