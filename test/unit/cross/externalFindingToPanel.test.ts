import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

/**
 * 外から置いた指摘が、提案パネルの読み取りでそのまま並ぶか（2026-10-01）。
 *
 * **MCP（置く側）と拡張機能（読む側）をまたぐ**ので `cross` に置く。
 * 置く側だけを試すと、「置いたのに画面に出ない」（ファイル名・相対パスの
 * 表記・分類名のずれ）を見落とす——どれもエラーにならず、黙って並ばない
 * だけになる（`core/findingSource.ts` の `findingFileKey` の断り書き）。
 *
 * 読む側は**製品の関数そのもの**（`primeSavedFindings`）を通す。
 */

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: {
        // **本物のディスクを読む。** 置き場は MCP が node の fs で書いたものなので
        readFile: vi.fn(async (uri: { fsPath: string }) =>
          new Uint8Array(fs.readFileSync(uri.fsPath))
        ),
        writeFile: vi.fn(async () => undefined),
        createDirectory: vi.fn(async () => undefined),
      },
    },
    Uri: { file: (p: string) => ({ fsPath: p }), parse: (p: string) => ({ fsPath: p }) },
    EventEmitter: class {
      event = () => ({ dispose: noop });
      fire = noop;
    },
    ThemeIcon: class {},
    ThemeColor: class {},
    MarkdownString: class {},
    Range: class {},
    Position: class {},
    ViewColumn: { One: 1 },
  };
});

/*
  本文の読み込みだけを差し替える（`vscode` を通さずにディスクから読む）。
  **ハッシュは製品と同じ作り方**（`hashBytes`）——ずらすと、原稿が変わって
  いないのに「変わった」と出るのを見落とす
*/
vi.mock("../../../src/core/textFile", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/core/textFile")>();
  const { hashBytes } = await import("../../../src/core/hash");
  return {
    ...original,
    readTextFile: vi.fn(async (filePath: string) => {
      const bytes = new Uint8Array(fs.readFileSync(filePath));
      return {
        text: new TextDecoder().decode(bytes),
        hash: hashBytes(bytes),
        encoding: "utf8",
        eol: "\n",
        hasTrailingNewline: true,
        hasConflictMarkers: false,
        hasMixedEol: false,
      };
    }),
  };
});

import { novelPropose } from "../../../src/mcp/tools/propose";
import { typoPrompt } from "../../../src/mcp/tools/typo";
import { setExternalClientName } from "../../../src/mcp/tools/accessLog";
import { primeSavedFindings } from "../../../src/features/primeFindings";
import type {
  ContradictionViewItem,
  ProposalPanel,
  ProposalViewItem,
} from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";

const FIXTURE = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const EPISODE = "本文/004_よあけ.txt";

const temporary: string[] = [];

interface Restored {
  category: string;
  items: ProposalViewItem[];
  contradictions: ContradictionViewItem[];
}

function fakePanel(into: Restored[]): ProposalPanel {
  return {
    showRestoredFindings(
      _work: WorkEntry,
      category: string,
      contents: { items?: ProposalViewItem[]; contradictions?: ContradictionViewItem[] }
    ): void {
      into.push({
        category,
        items: contents.items ?? [],
        contradictions: contents.contradictions ?? [],
      });
    },
  } as unknown as ProposalPanel;
}

function workCopy(): { folder: string; work: WorkEntry } {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-finding-panel-"));
  fs.cpSync(FIXTURE, folder, { recursive: true });
  temporary.push(folder);
  return {
    folder,
    work: {
      id: "w1",
      title: "試験の作品",
      folderPath: folder,
      registeredAt: "2026-10-01T00:00:00.000Z",
    },
  };
}

function place(folder: string): void {
  const chunkId = typoPrompt({ folder, filePath: EPISODE, numCtx: 32768 }).chunks[0].chunkId;
  const result = novelPropose({
    folder,
    kind: "finding",
    feature: "typo",
    chunkId,
    response: JSON.stringify({
      issues: [
        {
          line: 2,
          original: "まず最初に、少年は窓を開けた。",
          target: "窓を開けた",
          suggestion: "窓を空けた",
          reason: "誤変換",
          confidence: "high",
        },
      ],
    }),
    model: "claude-sonnet-4-5",
  });
  expect(result.placedCount).toBe(1);
}

beforeEach(() => setExternalClientName("claude-code"));
afterEach(() => {
  setExternalClientName("");
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("外から置いた指摘を、提案パネルが読む", () => {
  test("誤字脱字のタブへ、外部AIの出どころつきで並ぶ", async () => {
    const { folder, work } = workCopy();
    place(folder);

    const restored: Restored[] = [];
    const count = await primeSavedFindings(work, fakePanel(restored));

    expect(count).toBe(1);
    expect(restored[0].category).toBe("誤字脱字");
    const item = restored[0].items[0];
    expect(item).toMatchObject({
      line: 2,
      target: "窓を開けた",
      suggestion: "窓を空けた",
      status: "pending",
      originLabel: "外部AI（claude-code・claude-sonnet-4-5）",
    });
    // 置いたあとで原稿は変わっていない——添え書きは出さない
    expect(item.originNote).toBeUndefined();
    // 当てる道は既存のまま（本文のありかは手元の絶対パスへ戻る）
    expect(nodePath.resolve(item.filePath)).toBe(nodePath.resolve(folder, EPISODE));
  });

  test("原文が消えるほど原稿が変わったら、並ばない（当てられない）", async () => {
    const { folder, work } = workCopy();
    place(folder);
    const file = nodePath.join(folder, EPISODE);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace("少年は窓を開けた", "少年は扉を閉めた"),
      "utf8"
    );

    const restored: Restored[] = [];
    const count = await primeSavedFindings(work, fakePanel(restored));

    expect(count).toBe(0);
    expect(restored).toHaveLength(0);
  });

  test("ほかの所が変わっただけなら並び、原稿が変わったことを添える", async () => {
    const { folder, work } = workCopy();
    place(folder);
    const file = nodePath.join(folder, EPISODE);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace("湯を沸かし", "茶を淹れ"),
      "utf8"
    );

    const restored: Restored[] = [];
    await primeSavedFindings(work, fakePanel(restored));

    const item = restored[0].items[0];
    expect(item.originLabel).toBe("外部AI（claude-code・claude-sonnet-4-5）");
    expect(item.originNote).toContain("置いたあとで原稿が変わっています");
  });
});
