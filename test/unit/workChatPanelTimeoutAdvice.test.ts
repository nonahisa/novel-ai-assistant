import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "vscode";
import type { WorkEntry } from "../../src/models/types";
import { useMemoryTuningStore } from "./support/tuningStore";

/**
 * 相談パネルの時間切れの案内（ノートPCの実機、2026-09-23）。
 *
 * CPUだけの Ollama（gemma4:e2b）で、送信24,209字の相談が読み込みだけで
 * 約620秒かかり、上限の600秒で切れた。赤字は各画面共通の案内
 * （`recoveryForAIError`）で、**2つとも効かない操作**を勧めていた。
 *
 * - 「タイムアウトの秒数を延ばしてください」——待ち時間は既に上限
 *   （台帳は1800秒だが、読む側で600秒に抑えられる）
 * - 「1チャンクの文字数を小さく」——相談はチャンクに分けない
 *
 * 見るのは、上限に当たったときに効かない操作を言わないことと、
 * 上限未満なら今までどおり延ばす札が出ること（見逃しと誤検出の両方）。
 */

const response = vi.hoisted(() => ({
  error: undefined as unknown,
}));

vi.mock("../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));

vi.mock("../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

vi.mock("../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));

const { WorkChatPanel } = await import("../../src/features/workChatPanel");
const { AIError, recoveryForAIError } = await import("../../src/ai/types");

const WORK: WorkEntry = {
  id: "w_a",
  title: "氷の街",
  folderPath: "C:\\novels\\w_a",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

interface Posted {
  type: string;
  message?: string;
  actions?: Array<{ label: string; command: string }>;
}

function fakeView(posted: Posted[]) {
  return {
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
  };
}

function fakeAi(providerId: string, model: string) {
  return {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: providerId,
        displayName: providerId === "sakura" ? "さくらのAI" : "Ollama",
        isPaid: false,
        generate: async () => {
          throw response.error;
        },
      },
      model,
    }),
  };
}

type Panel = InstanceType<typeof WorkChatPanel>;

function harness(providerId: string, model: string): {
  panel: Panel;
  posted: Posted[];
} {
  const posted: Posted[] = [];
  const registry = { list: () => [WORK] };
  const runner = { run: async () => undefined };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    fakeAi(providerId, model) as unknown as ConstructorParameters<
      typeof WorkChatPanel
    >[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView(posted) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any).findRelated = async () => ({
    reference: [],
    searchTerms: [],
    materials: [],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any).resolveContext = async () => ({
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

async function ask(panel: Panel, question: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).ask(question);
}

/** 実機で出た文言そのまま */
const TIMEOUT_600 = () =>
  new AIError("Ollamaの応答がタイムアウトしました（600秒）。", "timeout");

const originalConfig = workspace.getConfiguration;

beforeEach(async () => {
  response.error = undefined;
  await useMemoryTuningStore({});
  workspace.getConfiguration = (() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
    update: async () => undefined,
  })) as unknown as typeof workspace.getConfiguration;
});

afterEach(() => {
  workspace.getConfiguration = originalConfig;
});

describe("待ち時間が上限に当たっているとき", () => {
  beforeEach(async () => {
    // 実機と同じ形。**台帳は1800秒でも、読む側で600秒に抑えられる**
    await useMemoryTuningStore({
      "ollama/gemma4:e2b": { timeoutSeconds: 1800 },
    });
  });

  test("効かない操作（延ばす・チャンク）を勧めない", async () => {
    response.error = TIMEOUT_600();
    const { panel, posted } = harness("ollama", "gemma4:e2b");

    await ask(panel, "この作品の弱いところはどこですか");

    const error = posted.find((m) => m.type === "error");
    expect(error, "失敗の案内が出ていない").toBeTruthy();
    expect(error!.message).not.toContain("延ばしてください");
    expect(error!.message).not.toContain("チャンク");
    expect(error!.message).toContain("上限（600秒）");
    // 押しても変わらない札は出さない（これまでどおり）
    expect(error!.actions).toBeUndefined();
  });

  test("送った量を字数で添える", async () => {
    response.error = TIMEOUT_600();
    const { panel, posted } = harness("ollama", "gemma4:e2b");

    await ask(panel, "この作品の弱いところはどこですか");

    const error = posted.find((m) => m.type === "error")!;
    expect(error.message).toMatch(/送った量は[0-9,]+字/);
  });

  test("会話が長くないなら、より速いAIを選ぶよう案内する", async () => {
    response.error = TIMEOUT_600();
    const { panel, posted } = harness("ollama", "gemma4:e2b");

    await ask(panel, "この作品の弱いところはどこですか");

    const error = posted.find((m) => m.type === "error")!;
    expect(error.message).toContain("より速いAI");
    // 会話が無いのに「最初から」を勧めても、送る量は減らない
    expect(error.message).not.toContain("最初から");
  });

  test("これまでのやり取りが重いなら、「最初から」で減らせると案内する", async () => {
    response.error = TIMEOUT_600();
    const { panel, posted } = harness("ollama", "gemma4:e2b");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (panel as any).history = [
      { role: "author", text: "問い".repeat(3_000) },
      { role: "assistant", text: "答え".repeat(3_000) },
    ];

    await ask(panel, "この作品の弱いところはどこですか");

    const error = posted.find((m) => m.type === "error")!;
    expect(error.message).toContain("最初から");
    expect(error.message).not.toContain("より速いAI");
    expect(error.message).not.toContain("チャンク");
  });
});

describe("待ち時間がまだ上限未満のとき", () => {
  test("延ばす札を出し、チャンクの話はしない", async () => {
    response.error = new AIError("応答がありませんでした。", "timeout");
    const { panel, posted } = harness("sakura", "gpt-oss-120b");

    await ask(panel, "この作品の弱いところはどこですか");

    const error = posted.find((m) => m.type === "error")!;
    expect(error.actions?.[0].label).toBe("タイムアウトを360秒にする");
    expect(error.message).toContain("延ば");
    expect(error.message).not.toContain("チャンク");
  });
});

describe("ほかの画面の案内は変えない", () => {
  test("共通の案内には、これまでどおりチャンクの話が残る", () => {
    const text = recoveryForAIError(new AIError("x", "timeout"));
    expect(text).toContain("1チャンクの文字数");
    expect(text).toContain("延ばしてください");
  });

  test("タイムアウト以外の失敗は、共通の案内のまま", async () => {
    response.error = new AIError("APIキーが違います。", "authentication_failed");
    const { panel, posted } = harness("sakura", "gpt-oss-120b");

    await ask(panel, "この作品の弱いところはどこですか");

    const error = posted.find((m) => m.type === "error")!;
    expect(error.message).toContain(
      recoveryForAIError(new AIError("x", "authentication_failed"))
    );
  });
});
