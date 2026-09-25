import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 提案パネルで作者が採った・退けたを、指摘を出したモデルごとに数える
 * （設計書6.49.7。作者の判断、2026-09-26）。
 *
 * 数え方そのもの（`core/verdictTally.ts`）は別のテストが見ている。ここは
 * **実際のパネルを通して**、押した操作がモデルの名前つきで記録へ届くかを見る。
 * 記録にモデルの名前が無ければ、どれだけ判断を重ねても数えようがない。
 */

let text = "";
const files = new Map<string, Uint8Array>();
let editorMode = false;

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn(),
      setStatusBarMessage: vi.fn(),
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
  isEditorMode: () => editorMode,
  manualActor: () => "author",
  recordEdit: vi.fn(async () => undefined),
}));

vi.mock("../../../src/features/sceneMemoPanel", () => ({
  refreshSceneMemoFindings: vi.fn(async () => undefined),
}));

vi.mock("../../../src/core/proposalStore", () => ({
  ProposalStore: class {
    async propose(): Promise<void> {
      return undefined;
    }
  },
}));

vi.mock("../../../src/core/gitAttribution", () => ({
  tryGitUserName: vi.fn(async () => "編集部"),
}));

/** 再チェックはAIを呼ばず、「解消した」と答える（配線だけを見る） */
vi.mock("../../../src/features/recheckProposal", () => ({
  recheckProposal: vi.fn(async () => ({
    kind: "resolved",
    reason: "設定どおりの表記に直っています",
  })),
}));

import { ProposalPanel } from "../../../src/features/proposalPanel";
import type {
  ProposalViewItem,
  RecordUpdateViewItem,
} from "../../../src/features/proposalPanel";
import { loadVerdictCounts } from "../../../src/features/verdictStore";
import { FindingStore } from "../../../src/features/findingStore";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-19T00:00:00.000Z",
};

const FILE = "C:/小説/いじめられっ子/本文/003.txt";
const original = "　彼は走つた。\n　夜が明けた。\n";

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

/** いまの割当。機能ごとに返すモデルを変えられるようにする */
let assigned: Record<string, string> = {};

function fakeRegistry(): AIRegistry {
  return {
    resolve: (feature: string) => {
      const model = assigned[feature] ?? "gemma4:12b";
      return { provider: { id: "ollama", isPaid: false }, model };
    },
  } as unknown as AIRegistry;
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

function newPanel(options: { withoutAi?: boolean } = {}): ProposalPanel {
  const panel = new ProposalPanel(options.withoutAi ? undefined : fakeRegistry());
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
  type: "apply" | "undo" | "dismiss",
  id: string
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type, id });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  text = original;
  files.clear();
  editorMode = false;
  assigned = {};
});

describe("押した判断が、出したモデルの名前つきで残る", () => {
  test("採ると、そのモデルの誤字脱字に「採った」が1件入る", async () => {
    const panel = newPanel();
    panel.showResults(work, [typo]);
    await settle();

    await press(panel, "apply", itemsOf(panel)[0].id);

    expect(await loadVerdictCounts([work])).toEqual([
      {
        providerId: "ollama",
        model: "gemma4:12b",
        feature: "typo",
        accepted: 1,
        dismissed: 0,
      },
    ]);
  });

  test("見送ると「退けた」に入る", async () => {
    const panel = newPanel();
    panel.showResults(work, [typo]);
    await settle();

    await press(panel, "dismiss", itemsOf(panel)[0].id);

    expect(await loadVerdictCounts([work])).toEqual([
      expect.objectContaining({ accepted: 0, dismissed: 1 }),
    ]);
  });

  test("採ってから戻すと、数えない", async () => {
    const panel = newPanel();
    panel.showResults(work, [typo]);
    await settle();
    const id = itemsOf(panel)[0].id;

    await press(panel, "apply", id);
    await press(panel, "undo", id);

    expect(await loadVerdictCounts([work])).toEqual([]);
  });

  test("置き場にも、出したモデルを残す（何日か後に採っても数えられるように）", async () => {
    const panel = newPanel();
    panel.showResults(work, [typo]);
    await settle();

    const [saved] = await new FindingStore(work).load();
    expect(saved.producer).toEqual({ providerId: "ollama", model: "gemma4:12b" });
  });
});

describe("出したモデルは、届いたときのもの", () => {
  test("置き場から戻した指摘は、いまの割当ではなく残しておいたモデルに数える", async () => {
    // いまの割当は 12b。戻した指摘は e4b が出したもの
    assigned = { typo: "gemma4:12b" };
    const panel = newPanel();
    panel.showRestoredFindings(work, "誤字脱字", {
      items: [
        {
          id: "f-restored",
          findingId: "f-restored",
          filePath: FILE,
          fileName: "003.txt",
          chunkHash: "",
          line: 1,
          original: typo.original,
          target: typo.target,
          suggestion: typo.suggestion,
          reason: "誤字脱字",
          confidence: "medium",
          status: "pending",
          producedBy: { providerId: "ollama", model: "gemma4:e4b" },
        },
      ],
    });

    await press(panel, "apply", "f-restored");

    expect(await loadVerdictCounts([work])).toEqual([
      expect.objectContaining({ model: "gemma4:e4b", accepted: 1 }),
    ]);
  });

  test("出したモデルが分からない古い指摘は、数えない（当て推量で割り振らない）", async () => {
    const panel = newPanel();
    panel.showRestoredFindings(work, "誤字脱字", {
      items: [
        {
          id: "f-old",
          findingId: "f-old",
          filePath: FILE,
          fileName: "003.txt",
          chunkHash: "",
          line: 1,
          original: typo.original,
          target: typo.target,
          suggestion: typo.suggestion,
          reason: "誤字脱字",
          confidence: "medium",
          status: "pending",
        },
      ],
    });

    await press(panel, "apply", "f-old");

    expect(await loadVerdictCounts([work])).toEqual([]);
  });

  test("推敲は推敲の割当のモデルに数える", async () => {
    assigned = { proofread: "qwen3:8b" };
    const panel = newPanel();
    panel.showResults(work, [typo], "推敲");
    await settle();

    await press(panel, "dismiss", itemsOf(panel)[0].id);

    expect(await loadVerdictCounts([work])).toEqual([
      expect.objectContaining({
        model: "qwen3:8b",
        feature: "proofread",
        dismissed: 1,
      }),
    ]);
  });
});

describe("手で直して片付いたもの", () => {
  test("矛盾を手で直し、再チェックで解消を確かめたら「採った」に数える", async () => {
    assigned = { contradiction: "gemma4:26b" };
    const panel = newPanel();
    panel.showContradictions(work, [
      {
        filePath: FILE,
        chunkHash: "h1",
        line: 2,
        excerpt: "　夜が明けた。",
        category: "時系列",
        settingSays: "夜のまま",
        textSays: "夜が明けた",
        note: "",
        confidence: "high",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);
    await settle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (panel as any).contradictions[0].id as string;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handleMessage({ type: "recheck", id });

    expect(await loadVerdictCounts([work])).toEqual([
      expect.objectContaining({
        model: "gemma4:26b",
        feature: "contradiction",
        accepted: 1,
        dismissed: 0,
      }),
    ]);
  });
});

describe("数えないもの", () => {
  test("表記ゆれ（AIを使わない）は数えない", async () => {
    const panel = newPanel();
    panel.showResults(work, [typo], "表記ゆれ");
    await settle();

    await press(panel, "apply", itemsOf(panel)[0].id);

    expect(await loadVerdictCounts([work])).toEqual([]);
  });

  test("編集者モードの見送りは数えない（作者が採った率なので）", async () => {
    editorMode = true;
    const panel = newPanel();
    panel.showResults(work, [typo]);
    await settle();

    await press(panel, "dismiss", itemsOf(panel)[0].id);

    expect(await loadVerdictCounts([work])).toEqual([]);
  });

  test("AIの登録簿が渡っていなければ、出したモデルが分からないので数えない", async () => {
    const panel = newPanel({ withoutAi: true });
    panel.showResults(work, [typo]);
    await settle();

    await press(panel, "apply", itemsOf(panel)[0].id);

    expect(await loadVerdictCounts([work])).toEqual([]);
  });
});

describe("伏線の候補", () => {
  function candidate(): RecordUpdateViewItem {
    return {
      id: "f:h1:0",
      name: "赤い鍵",
      changes: ["第1話で張られています", "引用：「赤い鍵」"],
      source: "001.txt",
      status: "pending",
      applyLabel: "登録",
    };
  }

  test("登録すると、伏線の検知の割当のモデルに「採った」が入る", async () => {
    assigned = { foreshadow: "gemma4:26b" };
    const panel = newPanel();
    panel.showRecordUpdates(
      work,
      [candidate()],
      async () => ({ ok: true }),
      async () => ({ ok: true }),
      "伏線の候補"
    );

    await press(panel, "apply", "f:h1:0");

    expect(await loadVerdictCounts([work])).toEqual([
      expect.objectContaining({
        model: "gemma4:26b",
        feature: "foreshadow",
        accepted: 1,
      }),
    ]);
  });

  test("見送ると「退けた」に入る", async () => {
    const panel = newPanel();
    panel.showRecordUpdates(
      work,
      [candidate()],
      async () => ({ ok: true }),
      async () => ({ ok: true }),
      "伏線の候補"
    );

    await press(panel, "dismiss", "f:h1:0");

    expect(await loadVerdictCounts([work])).toEqual([
      expect.objectContaining({ feature: "foreshadow", dismissed: 1 }),
    ]);
  });

  test("設定資料の更新は数えない（出したAIを後から確かめられない）", async () => {
    const panel = newPanel();
    panel.showRecordUpdates(
      work,
      [candidate()],
      async () => ({ ok: true }),
      async () => ({ ok: true })
    );

    await press(panel, "apply", "f:h1:0");

    expect(await loadVerdictCounts([work])).toEqual([]);
  });
});
