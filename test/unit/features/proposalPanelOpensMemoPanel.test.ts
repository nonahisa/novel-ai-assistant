import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * **検知が終わったら、校正・メモパネルを開く**（作者の裁定、2026-10-04）。
 *
 * 作者の報告：Ctrl+Alt+T（誤字脱字）が終わると、提案パネルが開く。
 * 裁定：終わったら校正・メモパネルを開く（すでに開いていれば前に出して
 * 読み直す）。提案パネルは［提案へ］や「提案パネルを開く」から、今までどおり開ける。
 *
 * - 校正・メモパネルに並ぶ種類（`core/findingSource.ts` の `RECORDED`：誤字脱字・
 *   表記ゆれ・推敲・矛盾・矛盾（事実の照合）・プロット逸脱）→ 校正・メモパネル
 * - 並ばない種類（設定資料の更新・名前の付け替え・単話プロット・編集部からの提案・
 *   バックアップとの違い）→ 今までどおり提案パネル
 * - 編集者モードでは校正・メモパネルを開けない（［済み］が本文のメモ行を消すため。
 *   `core/editorMode.ts`）ので、今までどおり提案パネル
 *
 * 画面の道筋は E2E `test/e2e/checkOpensMemoPanel.test.ts` が見る。
 */

const commands: Array<{ command: string; args: unknown[] }> = [];
let mode = "author";

vi.mock("vscode", () => {
  const noop = () => undefined;
  class TabInputWebview {
    constructor(public readonly viewType: string) {}
  }
  return {
    commands: {
      executeCommand: vi.fn((command: string, ...args: unknown[]) => {
        commands.push({ command, args });
        return Promise.resolve(undefined);
      }),
    },
    window: {
      createWebviewPanel: vi.fn(),
      tabGroups: { all: [] },
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback?: unknown) => (key === "mode" ? mode : fallback),
      }),
      fs: { readFile: vi.fn(), writeFile: vi.fn(), createDirectory: vi.fn() },
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
    TabInputWebview,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  };
});

import { OPEN_PROPOSALS_COMMAND, ProposalPanel } from "../../../src/features/proposalPanel";
import { OPEN_SCENE_MEMOS_COMMAND } from "../../../src/core/sceneMemo";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "教科書チート",
  folderPath: "C:/小説/教科書チート",
  registeredAt: "2026-10-04T00:00:00.000Z",
};

const typo = {
  filePath: "C:/小説/教科書チート/本文/001.txt",
  chunkHash: "h1",
  line: 3,
  original: "その日はは晴れていた。",
  target: "はは",
  suggestion: "は",
  reason: "重複",
  confidence: "high" as const,
};

const contradiction = {
  filePath: "C:/小説/教科書チート/本文/002.txt",
  chunkHash: "h2",
  line: 5,
  excerpt: "彼女の瞳は青かった。",
  category: "人物" as const,
  settingSays: "瞳は茶色",
  textSays: "瞳は青",
  note: "",
  confidence: "high" as const,
  severity: "medium" as const,
};

const named = (command: string) => commands.filter((entry) => entry.command === command);

/** 開く呼び出しは、指摘を書き終えたあと（約束が済んだあと）に来る */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  commands.length = 0;
  mode = "author";
});

describe("校正・メモパネルに並ぶ種類は、終わったら校正・メモパネルを開く", () => {
  for (const category of ["誤字脱字", "表記ゆれ", "推敲"]) {
    test(`${category}：校正・メモパネルを、書く手を奪わずに開く。提案パネルは開かない`, async () => {
      const panel = new ProposalPanel();
      panel.showResults(work, [typo], category);
      await vi.waitFor(() => expect(named(OPEN_SCENE_MEMOS_COMMAND)).toHaveLength(1));
      await settle();

      expect(named(OPEN_SCENE_MEMOS_COMMAND)[0].args).toEqual([
        { type: "work", work },
        { preserveFocus: true },
      ]);
      expect(named(OPEN_PROPOSALS_COMMAND)).toHaveLength(0);
    });
  }

  test("指摘が0件でも、校正・メモパネルを開く（終わったことが見える）", async () => {
    const panel = new ProposalPanel();
    panel.showResults(work, [], "誤字脱字");
    await vi.waitFor(() => expect(named(OPEN_SCENE_MEMOS_COMMAND)).toHaveLength(1));
    expect(named(OPEN_PROPOSALS_COMMAND)).toHaveLength(0);
  });

  test("矛盾・プロット逸脱も同じ", async () => {
    const panel = new ProposalPanel();
    panel.showContradictions(work, [contradiction]);
    await vi.waitFor(() => expect(named(OPEN_SCENE_MEMOS_COMMAND)).toHaveLength(1));
    panel.showDeviations(work, [
      {
        filePath: contradiction.filePath,
        chunkHash: "h3",
        lineStart: 2,
        lineEnd: 2,
        excerpt: contradiction.excerpt,
        type: "逸脱",
        plotReference: "第2話で出会う",
        reason: "出会わない",
        confidence: "medium",
        severity: "medium",
      },
    ]);
    await vi.waitFor(() => expect(named(OPEN_SCENE_MEMOS_COMMAND)).toHaveLength(2));
    await settle();
    expect(named(OPEN_PROPOSALS_COMMAND)).toHaveLength(0);
  });

  test("提案パネルの中身は今までどおり追う（［提案へ］や開き直しで、その分類が出る）", async () => {
    const panel = new ProposalPanel();
    panel.showResults(work, [typo], "誤字脱字");
    await vi.waitFor(() => expect(named(OPEN_SCENE_MEMOS_COMMAND)).toHaveLength(1));
    expect(panel.remainingIn(work, "誤字脱字")).toBe(1);
  });

  test("置き場から静かに戻したときは、どちらも開かない", async () => {
    const panel = new ProposalPanel();
    panel.showRestoredFindings(work, "誤字脱字", {
      items: [
        {
          id: "f1",
          filePath: typo.filePath,
          fileName: "001.txt",
          chunkHash: "",
          line: typo.line,
          original: typo.original,
          target: typo.target,
          suggestion: typo.suggestion,
          reason: typo.reason,
          detail: "",
          confidence: "high",
          status: "pending",
        },
      ],
    });
    await settle();
    expect(named(OPEN_SCENE_MEMOS_COMMAND)).toHaveLength(0);
    expect(named(OPEN_PROPOSALS_COMMAND)).toHaveLength(0);
  });
});

describe("校正・メモパネルに並ばない種類は、今までどおり提案パネル", () => {
  for (const category of ["名前の付け替え", "編集部からの提案"]) {
    test(`${category}`, async () => {
      const panel = new ProposalPanel();
      panel.showResults(work, [typo], category);
      await settle();
      expect(named(OPEN_PROPOSALS_COMMAND)).toEqual([
        { command: OPEN_PROPOSALS_COMMAND, args: [{ preserveFocus: true }] },
      ]);
      expect(named(OPEN_SCENE_MEMOS_COMMAND)).toHaveLength(0);
    });
  }

  test("設定資料の更新", async () => {
    const panel = new ProposalPanel();
    panel.showRecordUpdates(
      work,
      [],
      () => Promise.resolve({ ok: true }),
      () => Promise.resolve({ ok: true })
    );
    await settle();
    expect(named(OPEN_PROPOSALS_COMMAND)).toHaveLength(1);
    expect(named(OPEN_SCENE_MEMOS_COMMAND)).toHaveLength(0);
  });
});

describe("編集者モードでは、今までどおり提案パネル", () => {
  test("誤字脱字でも校正・メモパネルは開かない（編集者モードでは使えない画面）", async () => {
    mode = "editor";
    const panel = new ProposalPanel();
    panel.showResults(work, [typo], "誤字脱字");
    await settle();
    expect(named(OPEN_PROPOSALS_COMMAND)).toEqual([
      { command: OPEN_PROPOSALS_COMMAND, args: [{ preserveFocus: true }] },
    ]);
    expect(named(OPEN_SCENE_MEMOS_COMMAND)).toHaveLength(0);
  });
});
