import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "vscode";
import type { WorkEntry } from "../../../src/models/types";
import { useMemoryTuningStore } from "../support/tuningStore";

/**
 * 相談パネルが、実行したふりの答え（「診断を実行します」）に断りを添えるか
 * （0.86.10 の担当の報告。見分ける規則そのものは
 * `test/unit/core/chatExecutionClaim.test.ts`）。
 *
 * 旧名で頼まれた gemma4:26b が「診断を実行します」と答え、実行ボタンは
 * 付かなかった。相談のAIは操作を動かせないので、作者は待つだけになる。
 * 組み方は `workChatPanelTruncated.test.ts` と同じ（AIだけ作り物）。
 */

const response = vi.hoisted(() => ({ text: "" }));

vi.mock("../../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));

vi.mock("../../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_a",
  title: "氷の街",
  folderPath: "C:\\novels\\w_a",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

interface Posted {
  type: string;
  message?: string;
  reply?: string;
  run?: unknown;
}

function harness(): { panel: InstanceType<typeof WorkChatPanel>; posted: Posted[] } {
  const posted: Posted[] = [];
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: async () => ({ text: response.text }),
      },
      model: "gemma4:26b",
    }),
  };
  const panel = new WorkChatPanel(
    { list: () => [WORK] } as never,
    ai as never,
    { run: async () => undefined } as never
  );
  panel.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: Posted) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = panel as any;
  inner.findRelated = async () => ({ reference: [], searchTerms: [], materials: [] });
  inner.resolveContext = async () => ({
    work: WORK,
    kind: "workOnly",
    filePath: WORK.folderPath,
    label: WORK.title,
    excerpt: "",
    truncated: false,
    fromSelection: false,
    reference: [],
  });
  return { panel, posted };
}

async function ask(panel: InstanceType<typeof WorkChatPanel>, question: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).ask(question);
}

function reply(text: string, run: string | null = null): string {
  return JSON.stringify({ reply: text, options: [], needFiles: [], run });
}

const CLAIM_NOTE = "相談のAIは操作を動かせないため";

const originalConfig = workspace.getConfiguration;
beforeEach(async () => {
  await useMemoryTuningStore({});
  workspace.getConfiguration = (() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
    update: async () => undefined,
  })) as unknown as typeof workspace.getConfiguration;
});
afterEach(() => {
  workspace.getConfiguration = originalConfig;
});

describe("実行したふりの答え", () => {
  test("再現：旧名で頼まれて「診断を実行します」と答え、ボタンが無い回は、断りを添える", async () => {
    const answerText = "承知いたしました。ターゲット読者診断を実行します。";
    response.text = reply(answerText);
    const h = harness();

    await ask(h.panel, "ターゲット読者診断を実行して");

    const answer = h.posted.find((m) => m.type === "answer");
    // 答えそのものは書き換えない
    expect(answer?.reply).toBe(answerText);
    const note = h.posted.find((m) => m.type === "note" && m.message?.includes(CLAIM_NOTE));
    expect(note?.message).toContain("「ターゲット読者診断を実行します」");
    expect(note?.message).toContain("何も始まっていません");
  });

  test("実行ボタンが付いた回は、押せば始まるので断らない", async () => {
    response.text = reply("誤字脱字の検知を実行します。", "checkTypos");
    const h = harness();

    await ask(h.panel, "誤字脱字を検知して");

    const answer = h.posted.find((m) => m.type === "answer");
    expect(answer?.run).toBeTruthy();
    expect(h.posted.some((m) => m.type === "note" && m.message?.includes(CLAIM_NOTE))).toBe(false);
  });

  test("創作の相談で作品の中の出来事を言っても、断らない", async () => {
    response.text = reply("終盤で主人公は作戦を実行します。そこまでの溜めが足りないように読めます。");
    const h = harness();

    await ask(h.panel, "第5話の展開が急すぎませんか");

    expect(h.posted.some((m) => m.type === "note" && m.message?.includes(CLAIM_NOTE))).toBe(false);
  });

  test("押す場所の案内は、断らない", async () => {
    response.text = reply(
      "詳細メニューの『自己校正』→『読者診断』→『ターゲット読者』を押すと、診断を実行します。"
    );
    const h = harness();

    await ask(h.panel, "ターゲット読者診断はどこから？");

    expect(h.posted.some((m) => m.type === "note" && m.message?.includes(CLAIM_NOTE))).toBe(false);
  });
});
