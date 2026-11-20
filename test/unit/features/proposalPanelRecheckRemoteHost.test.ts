import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 提案パネルの「再チェック」も、手元のAIの宛先がこの PC の外なら送る前に確かめる
 * （セキュリティ点検 2026-11-21 の続き。設計書6.78の17）。
 *
 * 再チェックは指摘の箇所の前後（本文）を送る。料金の確認（`confirmPaidUsage`）は有料のAIの
 * ときだけ呼ばれていたので、無料の手元のAIでは外の確認を1度も通らずに送っていた。
 */

const warned: Array<{ message: string; buttons: string[] }> = [];
let answer: string | undefined;
let endpoint = "http://192.168.1.20:11434";

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn((message: string, ...rest: unknown[]) => {
        warned.push({
          message,
          buttons: rest.filter((item): item is string => typeof item === "string"),
        });
        return Promise.resolve(answer);
      }),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      setStatusBarMessage: vi.fn(() => ({ dispose: noop })),
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback?: unknown) =>
          key === "ollama.endpoint" || key === "lmstudio.endpoint" ? endpoint : fallback,
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
    ViewColumn: { One: 1 },
  };
});

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: "　夕暮れの校庭に、影が長く伸びていた。\n　プラム様は振り返らなかった。\n",
    hash: "h",
    encoding: "utf8",
    eol: "\n",
    bom: false,
  })),
  sameFilePath: () => false,
  writeTextFilePreservingFormat: vi.fn(),
}));

const recheckCalls: unknown[] = [];
vi.mock("../../../src/features/recheckProposal", () => ({
  recheckProposal: vi.fn(async (request: unknown) => {
    recheckCalls.push(request);
    return { kind: "resolved", reason: "直っています" };
  }),
}));

const { ProposalPanel } = await import("../../../src/features/proposalPanel");
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-08-21T00:00:00.000Z",
};

function panelWithView(providerId: string) {
  const registry = {
    resolve: () => ({
      provider: { id: providerId, isPaid: false, displayName: "Ollama", generate: vi.fn() },
      model: "gemma4:e4b",
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panel = new ProposalPanel(registry as any);
  const view = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: () => Promise.resolve(true),
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(view as any);
  panel.showResults(work, [
    {
      filePath: "C:/小説/いじめられっ子/本文/003.txt",
      chunkHash: "h9",
      line: 2,
      original: "　プリム様は振り返らなかった。",
      target: "プリム様",
      suggestion: "プラム様",
      reason: "設定資料の表記",
      confidence: "high",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  ]);
  return panel;
}

async function pressRecheck(panel: InstanceType<typeof ProposalPanel>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (panel as any).items[0].id as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type: "recheck", id });
}

beforeEach(() => {
  warned.length = 0;
  recheckCalls.length = 0;
  answer = undefined;
  endpoint = "http://192.168.1.20:11434";
});

describe("提案パネルの再チェックと、外を指す手元のAI", () => {
  test("外なら送る前に訊き、断れば再チェックを送らない", async () => {
    const panel = panelWithView("ollama");
    await pressRecheck(panel);
    expect(warned.some((shown) => shown.message.includes("このパソコンの外"))).toBe(true);
    expect(recheckCalls).toEqual([]);
  });

  test("［送る］と答えれば送る", async () => {
    answer = "送る";
    const panel = panelWithView("ollama");
    await pressRecheck(panel);
    expect(recheckCalls).toHaveLength(1);
  });

  test("この PC の中なら訊かずに送る", async () => {
    endpoint = "http://localhost:11434";
    const panel = panelWithView("ollama");
    await pressRecheck(panel);
    expect(warned).toEqual([]);
    expect(recheckCalls).toHaveLength(1);
  });
});
