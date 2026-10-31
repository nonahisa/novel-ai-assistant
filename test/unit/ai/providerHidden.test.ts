import { afterEach, describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { AIRegistry } from "../../../src/ai/registry";
import { probeVsCodeLm } from "../../../src/ai/vscodeLmProvider";
import { extensions, lm, setStubChatModels } from "../support/vscodeStub";

/**
 * 口が働かないエディターでは、AIの選択肢から「VS Code に繋いであるAI」を
 * 外す（設計書5.9。作者の裁定 2026-10-31「Bにしましょう」）。
 */

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as vscode.ExtensionContext;
}

describe("AIの選択肢から外す", () => {
  test("隠すと一覧から消え、ほかの接続先は残る。選んであるものは切り替えない", async () => {
    const registry = new AIRegistry(fakeContext());
    await registry.select("vscode-lm", "copilot-x");
    expect(registry.listProviders().map((p) => p.id)).toContain("vscode-lm");

    registry.setProviderHidden("vscode-lm", true);
    const ids = registry.listProviders().map((p) => p.id);
    expect(ids).not.toContain("vscode-lm");
    expect(ids).toContain("gemini");
    expect(registry.selectedProviderId).toBe("vscode-lm");
    // 取り出す口は残す（キー割り当てや前の選択から呼ばれたときの受け皿）
    expect(registry.getProvider("vscode-lm")).toBeDefined();
  });
});

describe("口の確かめ（エディターの名前も拡張機能の名前も見ない）", () => {
  afterEach(() => {
    extensions.all = [];
    setStubChatModels([]);
  });

  test("モデルが0件で、モデルを出す拡張機能も無ければ「使えない」", async () => {
    extensions.all = [
      { id: "someone.other", packageJSON: { contributes: { commands: [] } } },
    ];
    expect(await probeVsCodeLm()).toBe("unavailable");
  });

  test("モデルが0件でも、モデルを出す拡張機能が入っていれば「使える」（起動が遅れているだけの人を守る）", async () => {
    extensions.all = [
      {
        id: "vscode.copilot",
        packageJSON: {
          contributes: { languageModelChatProviders: [{ vendor: "copilot" }] },
        },
      },
    ];
    expect(await probeVsCodeLm()).toBe("available");
  });

  test("モデルが1件でもあれば「使える」", async () => {
    setStubChatModels([
      {
        id: "m",
        name: "m",
        vendor: "v",
        family: "f",
        version: "1",
        maxInputTokens: 1000,
        sendRequest: async () => ({ text: (async function* () {})() }),
        countTokens: async () => 1,
      },
    ]);
    expect(await probeVsCodeLm()).toBe("available");
  });

  test("一覧を引くと投げるなら「使えない」", async () => {
    const original = lm.selectChatModels;
    lm.selectChatModels = async () => {
      throw new Error("not implemented");
    };
    try {
      expect(await probeVsCodeLm()).toBe("unavailable");
    } finally {
      lm.selectChatModels = original;
    }
  });

  test("口が無ければ「使えない」", async () => {
    const original = lm.selectChatModels;
    (lm as { selectChatModels?: unknown }).selectChatModels = undefined;
    try {
      expect(await probeVsCodeLm()).toBe("unavailable");
    } finally {
      lm.selectChatModels = original;
    }
  });
});
