import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 校正・メモパネルに、編集者の提案を並べる（作者の指示 2026-11-08「編集からの
 * 提案も校正メモにうつしてください」。設計書6.96.5）。
 *
 * - 作者モードでは、台帳の未決の提案が付箋・AIの指摘と同じ並び（話数 → 行）に入る
 * - 行の押し口は、直しの提案なら［採る］［見送る］、意見なら［読んだ］［本文へ］［見送る］
 * - 押すと決める口（`decideEditorProposal`）へ届き、決めた提案は一覧から消える
 * - 決める中身（本文・台帳・送り返し）は `editorProposalMemoDecide.test.ts` が本物の
 *   台帳で見る。ここは画面からの用件がどの口へ届くかだけを見る
 */

const files = new Map<string, Uint8Array>();
const posted: Array<{ type: string; data?: Record<string, unknown> }> = [];
let receive: ((message: unknown) => void) | undefined;

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      activeTextEditor: undefined,
      activeColorTheme: { kind: 1 },
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
      createWebviewPanel: () => ({
        webview: {
          html: "",
          cspSource: "vscode-webview:",
          onDidReceiveMessage: (handler: (message: unknown) => void) => {
            receive = handler;
            return { dispose: noop };
          },
          postMessage: (message: { type: string; data?: Record<string, unknown> }) => {
            posted.push(message);
            return Promise.resolve(true);
          },
        },
        onDidDispose: () => ({ dispose: noop }),
        reveal: noop,
        dispose: noop,
      }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
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
    ViewColumn: { One: 1, Beside: -2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
  };
});

const FILE_PATH = "C:/小説/いじめられっ子/本文/003.txt";

vi.mock("../../../src/core/scanner", () => ({
  scanWork: vi.fn(async () => ({
    episodes: [
      {
        filePath: "C:/小説/いじめられっ子/本文/003.txt",
        fileName: "003.txt",
        hasConflictMarkers: false,
      },
    ],
  })),
}));

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: "　彼は走つた。\n// TODO 二行目を見直す\n　夜が明けた。\n",
    hash: "h",
    encoding: "utf8",
    eol: "\n",
    bom: false,
  })),
  writeTextFilePreservingFormat: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: vi.fn(async () => ({})),
}));

vi.mock("../../../src/core/episodeLabel", () => ({
  collectedLabelIndex: () => ({ labelAt: () => "第3話" }),
  episodeTitle: () => "",
  formatChapterLabel: () => "第3話",
  isCollectedFile: () => false,
}));

vi.mock("../../../src/features/manuscriptEditor", () => ({
  lastManuscriptCaret: () => undefined,
  removeMemoLineInOpenManuscript: vi.fn(async () => ({ kind: "notOpen" })),
  restoreMemoLineInOpenManuscript: vi.fn(async () => ({ kind: "not_open" })),
}));

vi.mock("../../../src/features/revealLocation", () => ({
  revealTextLocation: vi.fn(async () => undefined),
}));

vi.mock("../../../src/views/openDocument", () => ({
  openGeneratedMarkdown: vi.fn(async () => undefined),
}));

import { openSceneMemoPanel } from "../../../src/features/sceneMemoPanel";
import { revealTextLocation } from "../../../src/features/revealLocation";
import type { WorkEntry } from "../../../src/models/types";

let workCount = 0;
function newWork(): WorkEntry {
  workCount += 1;
  return {
    id: `wp${workCount}`,
    title: "いじめられっ子",
    folderPath: "C:/小説/いじめられっ子",
    registeredAt: "2026-11-08T00:00:00.000Z",
  };
}

const context = { subscriptions: [] as unknown[] };

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function lastData(): Record<string, unknown> {
  const memos = posted.filter((message) => message.type === "memos");
  return memos[memos.length - 1]?.data ?? {};
}

function rows(): Array<Record<string, unknown>> {
  return (lastData().rows ?? []) as Array<Record<string, unknown>>;
}

/** 台帳の未決（`loadEditorProposalsForMemo` が返す形） */
const fixProposal = {
  id: "p1",
  file: "本文/003.txt",
  line: 3,
  original: "　夜が明けた。",
  target: "明けた",
  suggestion: "明けてゆく",
  reason: "時の流れを見せたい（kmizu の提案）",
  opinionOnly: false,
};

const opinion = {
  id: "p2",
  file: "本文/003.txt",
  line: 1,
  original: "　彼は走つた。",
  // 意見だけの提案は行ぜんたいを指し、直した案が空（`handProposalTarget`）
  target: "　彼は走つた。",
  suggestion: "",
  reason: "編集者のメモ：ここは間が長い（kmizu の提案）",
  opinionOnly: true,
};

/** 偽の台帳。決めたものは未決から外れる（本物と同じく、一覧から消える） */
function deps() {
  const pending = new Map([fixProposal, opinion].map((entry) => [entry.id, entry]));
  return {
    loadEditorProposals: vi.fn(async () => [...pending.values()]),
    decideEditorProposal: vi.fn(
      async (_work: WorkEntry, proposal: { id: string }, _decision: "accept" | "reject") => {
        pending.delete(proposal.id);
        return { ok: true as const };
      }
    ),
  };
}

beforeEach(() => {
  files.clear();
  posted.length = 0;
  receive = undefined;
  vi.mocked(revealTextLocation).mockClear();
});

describe("作者モードで、編集者の提案が校正・メモパネルの並びに入る", () => {
  test("付箋と同じ並び（話数 → 行）に、編集者の提案の行が入る", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, newWork(), deps());

    const kinds = rows().map((row) => `${row.kind}:${row.line}`);
    // 1行目の意見 → 2行目の付箋 → 3行目の直しの提案
    expect(kinds).toEqual(["proposal:1", "memo:2", "proposal:3"]);
    const fix = rows().find((row) => row.proposalId === "p1");
    expect(fix).toMatchObject({
      kind: "proposal",
      filePath: FILE_PATH,
      tag: "編集者の提案",
      text: "「明けた」→「明けてゆく」",
      proposalAction: "accept",
    });
    // 0.138.0 の「（kmizu の提案）」の添え書きを保つ
    expect(String(fix?.note)).toContain("（kmizu の提案）");
    expect(rows().find((row) => row.proposalId === "p2")?.proposalAction).toBe("read");
    expect(String(lastData().countsLabel)).toContain("編集者の提案 2件");
    // 絞り込みの選び口にも出る
    expect(lastData().tags as string[]).toContain("編集者の提案");
  });

  test("［採る］で決める口へ accept が届き、決めた行は一覧から消える", async () => {
    const work = newWork();
    const given = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, given);

    receive?.({ type: "decideProposal", proposalId: "p1", decision: "accept" });
    await settle();

    expect(given.decideEditorProposal).toHaveBeenCalledOnce();
    const [calledWork, calledProposal, decision] = given.decideEditorProposal.mock.calls[0];
    expect(calledWork.id).toBe(work.id);
    expect(calledProposal).toMatchObject({ id: "p1", line: 3, target: "明けた", suggestion: "明けてゆく" });
    expect(decision).toBe("accept");
    expect(rows().some((row) => row.proposalId === "p1")).toBe(false);
  });

  test("［見送る］で reject が届く", async () => {
    const given = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, newWork(), given);

    receive?.({ type: "decideProposal", proposalId: "p2", decision: "reject" });
    await settle();

    expect(given.decideEditorProposal.mock.calls[0][2]).toBe("reject");
    expect(rows().some((row) => row.proposalId === "p2")).toBe(false);
  });

  test("意見の［読んだ］は accept として届く（読んだの記録は決める側が書き分ける）", async () => {
    const given = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, newWork(), given);

    receive?.({ type: "decideProposal", proposalId: "p2", decision: "accept" });
    await settle();

    expect(given.decideEditorProposal.mock.calls[0][1]).toMatchObject({ id: "p2", opinionOnly: true });
    expect(given.decideEditorProposal.mock.calls[0][2]).toBe("accept");
  });

  test("決められなかったら理由を出し、行は残る", async () => {
    const vscode = await import("vscode");
    const given = deps();
    given.decideEditorProposal.mockResolvedValueOnce({
      ok: false,
      reason: "提案が届いてから本文が変わっているため、この提案の位置を特定できませんでした。",
    } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, newWork(), given);

    receive?.({ type: "decideProposal", proposalId: "p1", decision: "accept" });
    await settle();

    expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
      expect.stringContaining("本文が変わっている")
    );
    expect(rows().some((row) => row.proposalId === "p1")).toBe(true);
  });

  test("「次へ」で編集者の提案の行にも止まる", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, newWork(), deps());

    receive?.({ type: "next" });
    await settle();

    expect(vi.mocked(revealTextLocation).mock.calls[0]?.slice(0, 2)).toEqual([FILE_PATH, 1]);
  });

  test("並べる口が無ければ、編集者の提案は出ない（編集者モードは extension.ts が渡さない側）", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, newWork(), {});

    expect(rows().some((row) => row.kind === "proposal")).toBe(false);
  });
});
