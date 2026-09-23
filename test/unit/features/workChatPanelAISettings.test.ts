import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildWorkChatPanelHtml } from "../../src/views/workChatPanelHtml";
import { commands } from "./support/vscodeStub";
import type { WorkEntry } from "../../src/models/types";

/**
 * 相談パネルの上に出ているAIの名前（作者の指摘、2026-09-06）。
 *
 * 「LM Studio（ローカル）（google/gemma-4-e4b）」がリンクの色で出ているのに、
 * **押しても何も起きなかった**。押せそうに見えるものは押せなければならない
 * ——押して何も起きない場所は、作者に「壊れている」としか読めない。
 *
 * 行き先はAI設定（`novelai.setupAI`）。**コマンドを呼ぶのは拡張機能側**で、
 * 画面から届いた文字列がそのままコマンド名になる道は作らない（既存の流儀）。
 */

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

const { WorkChatPanel } = await import("../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_a",
  title: "氷の街",
  folderPath: "C:\\novels\\w_a",
  registeredAt: "2026-09-06T00:00:00.000Z",
};

const executed: string[] = [];

function fakeView() {
  return {
    visible: true,
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

function makePanel(): InstanceType<typeof WorkChatPanel> {
  const registry = { list: () => [WORK] };
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "lmstudio",
        displayName: "LM Studio（ローカル）",
        isPaid: false,
        generate: async () => ({ text: "{}" }),
      },
      model: "google/gemma-4-e4b",
    }),
  };
  const runner = { run: async () => undefined };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

beforeEach(() => {
  executed.length = 0;
  (
    commands as { executeCommand?: (...args: unknown[]) => unknown }
  ).executeCommand = (command: unknown) => {
    executed.push(String(command));
    return Promise.resolve(undefined);
  };
});

describe("AIの名前を押したら、AI設定を開く", () => {
  test("知らせが届いたら、AI設定のコマンドを実行する", async () => {
    const panel = makePanel();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handle({ type: "openAISettings" }, {
      postMessage: () => Promise.resolve(true),
    });

    expect(executed).toEqual(["novelai.setupAI"]);
  });
});

describe("画面の側", () => {
  const html = buildWorkChatPanelHtml("test-nonce", "vscode-resource:");
  const script = (() => {
    const found = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
    if (!found) throw new Error("スクリプトが見つかりません");
    return found[1];
  })();

  test("押せることが見た目でも分かる（リンクの色と指の形）", () => {
    expect(html).toContain("#context-provider");
    expect(html).toContain("cursor: pointer");
  });

  test("押したらAI設定を頼む（コマンド名は画面が持たない）", () => {
    expect(script).toContain("'openAISettings'");
    expect(script).not.toContain("novelai.setupAI");
  });

  test("スクリプトがJavaScriptとして読める", () => {
    expect(() => new Function(script)).not.toThrow();
  });
});
