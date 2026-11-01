import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 編集部の提案を見る（作者の判断 2026-11-01「1つにまとめる」。設計書5.6.11）。
 *
 * ## 起きたこと（作者の実機、0.120.1、2026-11-01）
 *
 * 編集部が返した表記ゆれの提案7件が、窓の読み込み直しのあとの自動の同期で
 * 「たゆたう鉛 - 実験用」の `.aiwriter/proposals/proposals.jsonl` に入った。
 * そのあと作者が「編集部提案取込」を押すと「新しい提案はありませんでした
 * （すべて取り込み済みです）」で終わり、提案パネルを開いても、作品の選び欄に
 * 実験用が出なかった（ほかの4作品は検知の結果で出ていた）。
 *
 * **原因**：選び欄はパネルが手元に持つ段（`buckets`）だけを並べる。開いたときの
 * 読み込みは、承認待ち・残した指摘・当てたもの・台帳の案を置き場から戻すが、
 * 編集部の提案の台帳（`ProposalStore`）を読む段が無かった。そのため、
 * 「編集部提案確認」を一度押すまで実験用はどこにも出ず、窓を読み込み直すと
 * 同期のときに並べた分も消えていた。
 *
 * ここでは作者の実データと同じ形（実験用に編集部の proposal 7件・decision 無し、
 * ほかの作品には検知の結果）で確かめる。
 */

const files = new Map<string, Uint8Array>();
const posted: Array<Record<string, unknown>> = [];
const informed: string[] = [];
const warned: string[] = [];
let editorMode = false;

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn(async () => undefined) },
    window: {
      showWarningMessage: vi.fn((message: string) => {
        warned.push(message);
        return Promise.resolve(undefined);
      }),
      showInformationMessage: vi.fn((message: string) => {
        informed.push(message);
        return Promise.resolve(undefined);
      }),
      showErrorMessage: vi.fn(),
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
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
        stat: vi.fn(async () => {
          throw new Error("FileNotFound");
        }),
      },
    },
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: "file" }),
      parse: (p: string) => ({ fsPath: p, scheme: "file" }),
    },
    EventEmitter: class {
      event = () => ({ dispose: noop });
      fire = noop;
    },
    ThemeIcon: class {},
    ThemeColor: class {},
    MarkdownString: class {},
    Range: class {},
    Position: class {},
    ViewColumn: { One: 1, Beside: -2 },
  };
});

vi.mock("../../../src/core/actorContext", () => ({
  isEditorMode: () => editorMode,
  currentMode: () => (editorMode ? "editor" : "author"),
  recordEdit: vi.fn(async () => undefined),
}));

vi.mock("../../../src/core/gitAttribution", () => ({
  tryGitUserName: vi.fn(async () => "nonahisa"),
}));

import { ProposalPanel } from "../../../src/features/proposalPanel";
import {
  primeEditorProposals,
  showEditorProposals,
  type EditorReceiveOutcome,
  type ShowEditorProposalsDeps,
} from "../../../src/features/reviewProposals";
import type { WorkEntry } from "../../../src/models/types";
import * as paths from "../../../src/core/paths";

const experiment: WorkEntry = {
  id: "w-exp",
  title: "たゆたう鉛 - 実験用",
  folderPath: "C:/Users/nonah/Documents/novel/たゆたう鉛 - 実験用",
  registeredAt: "2026-10-30T00:00:00.000Z",
};

/** 検知の結果だけを持つ作品（選び欄に出ていた4作品の代わり） */
const others: WorkEntry[] = [
  ["w-ijime", "いじめられっ子_確認用", 9],
  ["w-cold", "コールドスリープ", 6],
  ["w-tayu", "たゆたう鉛_確認用", 5],
  ["w-dungeon", "現代ダンジョンのインフラ担当", 5],
].map(([id, title]) => ({
  id: id as string,
  title: title as string,
  folderPath: `C:/小説/${title as string}`,
  registeredAt: "2026-10-01T00:00:00.000Z",
}));
const otherCounts = [9, 6, 5, 5];

// 製品と同じ繋ぎ方で場所を作る（Windows では区切りが円記号になる）
const ledgerPath = (work: WorkEntry): string =>
  paths.join(work.folderPath, ".aiwriter", "proposals", "proposals.jsonl");

/** 実データと同じ形：編集部の proposal 7件、decision は無い */
function putSevenProposals(): void {
  const lines = Array.from({ length: 7 }, (_, index) =>
    JSON.stringify({
      kind: "proposal",
      id: `p${index + 1}`,
      time: "2026-11-01T12:00:00.000Z",
      proposer: "kmizu",
      file: "本文/001.txt",
      line: index + 2,
      original: `　彼は振り返った。${index}`,
      target: "振り返った",
      suggestion: "振りかえった",
      reason: "表記ゆれ",
      category: "表記ゆれ",
    })
  );
  files.set(
    ledgerPath(experiment),
    new TextEncoder().encode(`${lines.join("\n")}\n`)
  );
}

function fakeView() {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: Record<string, unknown>) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

/** ほかの4作品に検知の結果がある状態のパネル（実機で開いたときと同じ） */
function panelWithOtherWorks(): ProposalPanel {
  const panel = new ProposalPanel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  others.forEach((work, workIndex) => {
    const items = Array.from({ length: otherCounts[workIndex] }, (_, index) => ({
      id: `${work.id}-${index}`,
      filePath: `${work.folderPath}/本文/001.txt`,
      fileName: "001.txt",
      chunkHash: `h${index}`,
      line: index + 1,
      original: `行${index}`,
      target: `行${index}`,
      suggestion: `直し${index}`,
      reason: "誤字",
      confidence: "high" as const,
      status: "pending" as const,
    }));
    panel.showRestoredFindings(work, "誤字脱字", { items });
  });
  return panel;
}

interface WorkSummaryLike {
  id: string;
  title: string;
  remaining: number;
  active: boolean;
}

function latest(): Record<string, unknown> {
  return posted[posted.length - 1] ?? {};
}

function latestWorks(): WorkSummaryLike[] {
  return (latest().works as WorkSummaryLike[] | undefined) ?? [];
}

function deps(outcome: EditorReceiveOutcome): ShowEditorProposalsDeps {
  return { receive: vi.fn(async () => outcome) };
}

beforeEach(() => {
  files.clear();
  posted.length = 0;
  informed.length = 0;
  warned.length = 0;
  editorMode = false;
});

describe("提案パネルの作品の選び欄に、未決の編集者の提案がある作品を出す", () => {
  test("開いたときの読み込みで、実験用が7件で選び欄に出る（ほかの作品の検知の結果があっても）", async () => {
    putSevenProposals();
    const panel = panelWithOtherWorks();
    // 直す前は、ここに実験用が無かった
    expect(latestWorks().map((entry) => entry.title)).not.toContain(experiment.title);

    expect(await primeEditorProposals(experiment, panel)).toBe(7);

    const entry = latestWorks().find((work) => work.id === experiment.id);
    expect(entry).toMatchObject({ title: experiment.title, remaining: 7 });
    // ほかの作品の件数は変わらない
    expect(latestWorks().find((work) => work.id === "w-ijime")?.remaining).toBe(9);
  });

  test("静かに戻す：作者が見ている作品の画面は奪わず、知らせも出さない", async () => {
    putSevenProposals();
    const panel = panelWithOtherWorks();
    const before = latest().workTitle;

    await primeEditorProposals(experiment, panel);

    expect(latest().workTitle).toBe(before);
    expect(informed).toEqual([]);
  });

  test("採否を決めた提案は戻さない（decision があるものは数えない）", async () => {
    putSevenProposals();
    const decided = JSON.stringify({
      kind: "decision",
      proposalId: "p1",
      time: "2026-11-01T13:00:00.000Z",
      decidedBy: "nonahisa",
      status: "accepted",
      note: "",
    });
    const current = new TextDecoder().decode(files.get(ledgerPath(experiment)));
    files.set(ledgerPath(experiment), new TextEncoder().encode(`${current}${decided}\n`));
    const panel = panelWithOtherWorks();

    expect(await primeEditorProposals(experiment, panel)).toBe(6);
    expect(latestWorks().find((work) => work.id === experiment.id)?.remaining).toBe(6);
  });

  test("編集者モードでは戻さない（採るのは作者の判断）", async () => {
    editorMode = true;
    putSevenProposals();
    const panel = panelWithOtherWorks();

    expect(await primeEditorProposals(experiment, panel)).toBe(0);
    expect(latestWorks().map((entry) => entry.id)).not.toContain(experiment.id);
  });

  test("戻したあとに新しい命令で並べても、二重にならない", async () => {
    putSevenProposals();
    const panel = panelWithOtherWorks();
    await primeEditorProposals(experiment, panel);

    await showEditorProposals(experiment, panel, deps({ kind: "received", added: 0, pullFailed: false, lockMessages: [] }));

    expect(latestWorks().find((work) => work.id === experiment.id)?.remaining).toBe(7);
    expect(latest().items as unknown[]).toHaveLength(7);
  });
});

describe("編集者の提案を見る（受け取ってから並べる）", () => {
  test("新しく届いた分が0件でも、未決の7件を並べる（実機で「すべて取り込み済み」で止まっていた）", async () => {
    putSevenProposals();
    const panel = panelWithOtherWorks();

    const result = await showEditorProposals(
      experiment,
      panel,
      deps({ kind: "received", added: 0, pullFailed: false, lockMessages: [] })
    );

    expect(result.pending).toBe(7);
    // 作者が押した命令なので、ほかの作品を見ていても実験用へ移る
    expect(latest().workTitle).toBe(experiment.title);
    expect(latest().category).toBe("編集者からの提案");
    expect(latest().items as unknown[]).toHaveLength(7);
    expect(informed.join("\n")).toContain("編集者からの提案が 7 件あります");
    expect(informed.join("\n")).not.toContain("すべて取り込み済み");
  });

  test("いま届いた件数を添える", async () => {
    putSevenProposals();
    const panel = panelWithOtherWorks();

    await showEditorProposals(
      experiment,
      panel,
      deps({ kind: "received", added: 7, pullFailed: false, lockMessages: [] })
    );

    expect(informed.join("\n")).toContain("いま 7 件届きました");
  });

  test("受け取りに失敗しても（ネットが無い等）、手元にある未決を並べ、理由を1文添える", async () => {
    putSevenProposals();
    const panel = panelWithOtherWorks();

    const result = await showEditorProposals(
      experiment,
      panel,
      deps({ kind: "failed", detail: "fatal: unable to access" })
    );

    expect(result.pending).toBe(7);
    expect(latest().items as unknown[]).toHaveLength(7);
    const said = [...informed, ...warned].join("\n");
    expect(said).toContain("GitHubから受け取れませんでした");
    expect(said).toContain("手元にある分");
    // エラー文から原因を当てない（実装ルール5）。生の文は画面に出さない
    expect(said).not.toContain("fatal");
  });

  test("取り寄せ（早送り）が断られたときも、並べて理由を添える", async () => {
    putSevenProposals();
    const panel = panelWithOtherWorks();

    await showEditorProposals(
      experiment,
      panel,
      deps({ kind: "received", added: 0, pullFailed: true, lockMessages: [] })
    );

    expect(latest().items as unknown[]).toHaveLength(7);
    expect([...informed, ...warned].join("\n")).toContain("GitHubから受け取れませんでした");
  });

  test("ブラウザ版では受け取らずに、手元の未決を並べて理由を添える", async () => {
    putSevenProposals();
    const panel = panelWithOtherWorks();

    await showEditorProposals(experiment, panel, deps({ kind: "unavailable" }));

    expect(latest().items as unknown[]).toHaveLength(7);
    expect([...informed, ...warned].join("\n")).toContain("ブラウザ版");
  });

  test("未決が0件なら「未決の提案はありません」と言い、パネルは動かさない", async () => {
    const panel = panelWithOtherWorks();
    const before = latest().workTitle;

    const result = await showEditorProposals(
      experiment,
      panel,
      deps({ kind: "received", added: 0, pullFailed: false, lockMessages: [] })
    );

    expect(result.pending).toBe(0);
    expect(informed.join("\n")).toContain("未決の提案はありません");
    expect(latest().workTitle).toBe(before);
  });

  test("まだ渡していない作品で未決が0件なら、その旨も添える", async () => {
    const panel = panelWithOtherWorks();

    await showEditorProposals(experiment, panel, deps({ kind: "notShared" }));

    const said = informed.join("\n");
    expect(said).toContain("未決の提案はありません");
    expect(said).toContain("まだ編集者へ渡していません");
  });

  test("受け取りに失敗して未決も0件なら、0件と失敗の理由の両方を言う", async () => {
    const panel = panelWithOtherWorks();

    await showEditorProposals(experiment, panel, deps({ kind: "failed", detail: "x" }));

    const said = [...informed, ...warned].join("\n");
    expect(said).toContain("未決の提案はありません");
    expect(said).toContain("GitHubから受け取れませんでした");
  });

  test("校閲の範囲が動いた知らせも出す", async () => {
    putSevenProposals();
    const panel = panelWithOtherWorks();

    await showEditorProposals(
      experiment,
      panel,
      deps({
        kind: "received",
        added: 0,
        pullFailed: false,
        lockMessages: ["第1話の校閲が終わりました。"],
      })
    );

    expect(informed).toContain("第1話の校閲が終わりました。");
  });

  test("本文には触らない（書くのは何も無い）", async () => {
    putSevenProposals();
    const panel = panelWithOtherWorks();
    const before = new Map(files);

    await showEditorProposals(
      experiment,
      panel,
      deps({ kind: "received", added: 0, pullFailed: false, lockMessages: [] })
    );

    expect([...files.keys()]).toEqual([...before.keys()]);
  });
});

describe("分類の表示名（作者の判断 2026-11-01「編集者」「修正を提案する」）", () => {
  test("台帳の値「編集部の直し」「編集部のメモ」は、画面では「編集者の修正」「編集者のメモ」と出す", async () => {
    const lines = [
      { id: "h1", category: "編集部の直し", reason: "語順" },
      { id: "h2", category: "編集部のメモ", reason: "ここは言い切らない" },
    ].map((row, index) =>
      JSON.stringify({
        kind: "proposal",
        id: row.id,
        time: "2026-11-01T12:00:00.000Z",
        proposer: "kmizu",
        file: "本文/001.txt",
        line: index + 2,
        original: "　彼は振り返った。",
        target: "振り返った",
        suggestion: index === 0 ? "振りかえった" : "",
        reason: row.reason,
        category: row.category,
      })
    );
    files.set(ledgerPath(experiment), new TextEncoder().encode(`${lines.join("\n")}\n`));
    const panel = panelWithOtherWorks();

    await showEditorProposals(
      experiment,
      panel,
      deps({ kind: "received", added: 0, pullFailed: false, lockMessages: [] })
    );

    const reasons = (latest().items as Array<{ reason: string }>).map((item) => item.reason);
    expect(reasons[0]).toMatch(/^編集者の修正：語順/);
    expect(reasons[1]).toMatch(/^編集者のメモ：ここは言い切らない/);
    // 台帳の値は書き換えない（古い版の相手も読めるように）
    expect(new TextDecoder().decode(files.get(ledgerPath(experiment)))).toContain("編集部の直し");
  });
});
