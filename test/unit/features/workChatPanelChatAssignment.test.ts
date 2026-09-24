import { describe, expect, test, vi } from "vitest";
import type * as vscode from "vscode";
import { AIRegistry } from "../../../src/ai/registry";
import type { AIProvider, ModelInfo, ProviderId } from "../../../src/ai/types";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 相談パネル上部のエンジン表示は、**相談に割り当てたAI**に追従する
 * （設計書6.28.9。実機確認リスト F-24 の代わり）。
 *
 * `workChatPanelContextBadge.test.ts` は切り替えの合図で表示し直すことを、
 * `featureAssignments.test.ts` は割当を変えると合図が飛ぶことを、それぞれ
 * 作り物の相手で見ている。ここでは**本物の登録簿（`AIRegistry`）と本物の
 * パネル**をつなぎ、(1) 相談の割当を変えたらその場で表示が変わる、
 * (2) ほかの機能の割当では変わらない、の両方を見る——(2) が無いと
 * 「どの割当でも相談の表示が変わる」取り違えを見逃す。
 */

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

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_assign",
  title: "氷の街",
  folderPath: "C:\\novels\\w_assign",
  registeredAt: "2026-09-06T00:00:00.000Z",
};

function modelOf(id: string): ModelInfo {
  return {
    id,
    displayName: id,
    contextWindow: 8192,
    parameterSize: "8B",
    capabilities: ["JSON"],
    tier: "standard",
  };
}

function fakeProvider(id: ProviderId, label: string): AIProvider {
  return {
    id,
    displayName: label,
    isPaid: false,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "ok", modelCount: 1 }),
    listModels: async () => [modelOf("gemma4:e4b")],
    generate: async () => ({ text: "{}" }),
  } as unknown as AIProvider;
}

/** 本物の登録簿。中のプロバイダだけ作り物へ差し替える（HTTPへ行かせない） */
function registry(): AIRegistry {
  const store = new Map<string, unknown>();
  const context = {
    globalState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as vscode.ExtensionContext;
  const ai = new AIRegistry(context);
  const providers = (ai as unknown as { providers: Map<ProviderId, AIProvider> })
    .providers;
  providers.clear();
  providers.set("ollama", fakeProvider("ollama", "既定のAI"));
  providers.set("lmstudio", fakeProvider("lmstudio", "相談用のAI"));
  return ai;
}

function openPanel(ai: AIRegistry): unknown[] {
  const posted: unknown[] = [];
  const panel = new WorkChatPanel(
    { list: () => [WORK] } as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai,
    { run: async () => undefined } as unknown as ConstructorParameters<
      typeof WorkChatPanel
    >[2]
  );
  panel.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: unknown) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  } as never);
  return posted;
}

/** 画面へ送った、いちばん新しいエンジン表示 */
function lastProvider(posted: unknown[]): unknown {
  const contexts = posted.filter(
    (message) => (message as { type?: string }).type === "context"
  );
  return (contexts.at(-1) as { provider?: unknown } | undefined)?.provider;
}

describe("相談パネルのエンジン表示と、機能ごとの割当", () => {
  test("相談の割当を変えると、開いたままの表示がその場で変わる", async () => {
    const ai = registry();
    await ai.select("ollama", "gemma4:e4b");
    const posted = openPanel(ai);

    await ai.assign("chat", "lmstudio", "gemma4:e4b");

    await vi.waitFor(() =>
      expect(lastProvider(posted)).toBe("相談用のAI（gemma4:e4b）")
    );

    // 外せば既定へ戻る
    await ai.unassign("chat");
    await vi.waitFor(() =>
      expect(lastProvider(posted)).toBe("既定のAI（gemma4:e4b）")
    );
  });

  test("ほかの機能の割当では、相談の表示は変わらない", async () => {
    const ai = registry();
    await ai.select("ollama", "gemma4:e4b");
    const posted = openPanel(ai);

    await ai.assign("typo", "lmstudio", "gemma4:e4b");

    await vi.waitFor(() => expect(lastProvider(posted)).toBeDefined());
    expect(lastProvider(posted)).toBe("既定のAI（gemma4:e4b）");
  });
});
